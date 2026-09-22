import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GENERATED_HEADER_MARKER,
  TASK_ARTIFACT_VERSION,
  inspectTaskArtifacts,
  isNexusGenerated,
  materializeTaskArtifacts,
  readGeneratedHeader,
  renderTaskArtifact,
} from "../scripts/lib/task-artifacts.js";

const roots = [];

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function planText({ units = 1, goal = "Prevent cache reuse across identities." } = {}) {
  const blocks = Array.from({ length: units }, (_, index) => {
    const n = index + 1;
    return [
      `### Execution Unit ${n}: Correct cache identity ${n}`,
      `- id: unit-${n}`,
      `- user_outcome: Cache entries cannot leak between different keys (${n}).`,
      "- independently_shippable: true",
      "- review_boundary: NONE",
      "- estimated_lines: 60",
      "- Evidence:",
      `  - \`src/cache-${n}.js:42-70\``,
      "- Scope:",
      `  - In: \`src/cache-${n}.js\`, \`tests/cache-${n}.test.js\``,
      "- Acceptance criteria:",
      "  - [ ] same key still reuses",
      "  - [ ] different key cannot reuse",
      "- Verification gates:",
      `  1. \`npm test -- tests/cache-${n}.test.js\``,
      "- STOP conditions:",
      "  - STOP if public cache contract must change.",
      "",
    ].join("\n");
  });
  return [
    "# Plan: cache-key-fix",
    "",
    `- Planning mode: ${units === 1 ? "compact" : "standard"}`,
    "- Plan commit: abc1234",
    "",
    "## Goal",
    goal,
    "",
    "## Non-goals",
    "- No cache backend redesign.",
    "",
    ...(units === 1
      ? []
      : [
          "## Execution Unit Justification",
          `Number of units: ${units}`,
          "",
          "Why not fewer:",
          "- Separate independently shippable slices.",
          "",
          "Why not more:",
          "- Tests stay with their behavior.",
          "",
        ]),
    ...blocks,
  ].join("\n");
}

function worktreeWithPlan(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-task-artifacts-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".opencode", "plans"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opencode", "plans", "PLAN.md"), text);
  return root;
}

function taskFile(root, n = 1) {
  return path.join(root, ".opencode", "tasks", `task-${n}.md`);
}

test("materializes one generated view per execution unit", () => {
  const root = worktreeWithPlan(planText({ units: 2 }));
  const result = materializeTaskArtifacts({ worktree: root });
  assert.equal(result.ok, true);
  assert.equal(result.unit_count, 2);
  assert.equal(result.task_materialization_count, 2);
  assert.deepEqual(
    result.tasks.map((task) => [task.file, task.status, task.unit_id]),
    [
      [".opencode/tasks/task-1.md", "CREATED", "unit-1"],
      [".opencode/tasks/task-2.md", "CREATED", "unit-2"],
    ],
  );

  const content = fs.readFileSync(taskFile(root, 1), "utf8");
  assert.ok(content.startsWith(`<!-- ${GENERATED_HEADER_MARKER}`));
  const header = readGeneratedHeader(content);
  assert.equal(header.source, ".opencode/plans/PLAN.md");
  assert.equal(header.unit_id, "unit-1");
  assert.equal(header.generator, TASK_ARTIFACT_VERSION);
  assert.equal(header.plan_digest, result.plan_digest);
  for (const section of [
    "## Allowed files",
    "## Evidence",
    "## Acceptance criteria",
    "## Verification gates",
    "## STOP conditions",
  ]) {
    assert.ok(content.includes(section), section);
  }
  assert.ok(content.includes("src/cache-1.js"));
  assert.ok(content.includes("STOP if public cache contract must change."));
  assert.equal(content.includes("src/cache-2.js"), false);
});

test("regeneration is deterministic and idempotent", () => {
  const root = worktreeWithPlan(planText());
  const first = materializeTaskArtifacts({ worktree: root });
  const firstContent = fs.readFileSync(taskFile(root), "utf8");
  const second = materializeTaskArtifacts({ worktree: root });
  assert.deepEqual(
    second.tasks.map((task) => task.status),
    ["UNCHANGED"],
  );
  assert.equal(fs.readFileSync(taskFile(root), "utf8"), firstContent);
  assert.equal(second.plan_digest, first.plan_digest);
  assert.equal(
    renderTaskArtifact({
      unit: { id: "unit-1", title: "t", allowed_files: ["a.js"] },
      planDigest: "sha256:x",
    }),
    renderTaskArtifact({
      unit: { id: "unit-1", title: "t", allowed_files: ["a.js"] },
      planDigest: "sha256:x",
    }),
  );
});

test("a changed PLAN regenerates the view and rebinds the digest", () => {
  const root = worktreeWithPlan(planText());
  const before = materializeTaskArtifacts({ worktree: root });
  fs.writeFileSync(
    path.join(root, ".opencode", "plans", "PLAN.md"),
    planText({ goal: "Prevent stale cache reuse entirely." }),
  );
  const stale = inspectTaskArtifacts({ worktree: root });
  assert.equal(stale.current, false);
  assert.deepEqual(
    stale.stale_tasks.map((task) => task.status),
    ["WOULD_UPDATE"],
  );
  assert.equal(fs.readFileSync(taskFile(root), "utf8").includes("entirely"), false);

  const after_ = materializeTaskArtifacts({ worktree: root });
  assert.deepEqual(
    after_.tasks.map((task) => task.status),
    ["UPDATED"],
  );
  assert.notEqual(after_.plan_digest, before.plan_digest);
  const content = fs.readFileSync(taskFile(root), "utf8");
  assert.ok(content.includes("Prevent stale cache reuse entirely."));
  assert.equal(readGeneratedHeader(content).plan_digest, after_.plan_digest);
  assert.equal(inspectTaskArtifacts({ worktree: root }).current, true);
});

test("only provably generated stale views are removed", () => {
  const root = worktreeWithPlan(planText({ units: 2 }));
  materializeTaskArtifacts({ worktree: root });
  assert.ok(fs.existsSync(taskFile(root, 2)));

  fs.writeFileSync(
    path.join(root, ".opencode", "tasks", "notes.md"),
    "# hand written notes\n",
  );
  fs.writeFileSync(
    path.join(root, ".opencode", "tasks", "task-9.md"),
    "# user authored unit\n",
  );

  fs.writeFileSync(path.join(root, ".opencode", "plans", "PLAN.md"), planText({ units: 1 }));
  const result = materializeTaskArtifacts({ worktree: root });

  assert.deepEqual(
    result.removed.map((entry) => entry.file),
    [".opencode/tasks/task-2.md"],
  );
  assert.equal(fs.existsSync(taskFile(root, 2)), false);
  assert.deepEqual(
    result.preserved.map((entry) => [entry.file, entry.reason]).sort(),
    [
      [".opencode/tasks/notes.md", "USER_AUTHORED"],
      [".opencode/tasks/task-9.md", "USER_AUTHORED"],
    ].sort(),
  );
  assert.ok(fs.existsSync(path.join(root, ".opencode", "tasks", "task-9.md")));
  assert.ok(fs.existsSync(path.join(root, ".opencode", "tasks", "notes.md")));
});

test("a user-authored task-N.md is never overwritten", () => {
  const root = worktreeWithPlan(planText());
  fs.mkdirSync(path.join(root, ".opencode", "tasks"), { recursive: true });
  fs.writeFileSync(taskFile(root), "# my own task file\n");
  const result = materializeTaskArtifacts({ worktree: root });
  assert.deepEqual(
    result.tasks.map((task) => task.status),
    ["PRESERVED_USER_AUTHORED"],
  );
  assert.equal(fs.readFileSync(taskFile(root), "utf8"), "# my own task file\n");
  assert.equal(isNexusGenerated("# my own task file\n"), false);
});

test("a missing plan fails closed without writing views", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-task-artifacts-empty-"));
  roots.push(root);
  const result = materializeTaskArtifacts({ worktree: root });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PLAN_NOT_FOUND");
  assert.equal(result.task_materialization_count, 0);
  assert.equal(fs.existsSync(path.join(root, ".opencode", "tasks")), false);
});

test("materialization emits PR5 volume telemetry", () => {
  const root = worktreeWithPlan(planText({ units: 2 }));
  const events = [];
  const result = materializeTaskArtifacts({
    worktree: root,
    telemetry: { emit: (event) => events.push(event) },
    runId: "pr5-metrics",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "task_materialization");
  assert.equal(events[0].run_id, "pr5-metrics");
  assert.equal(events[0].plan_bytes, result.plan_bytes);
  assert.equal(events[0].generated_task_bytes, result.generated_task_bytes);
  assert.equal(events[0].task_materialization_count, 2);
});

test("generated views are not gate evidence: no gate module imports them", () => {
  const repoRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
  );
  for (const relative of [
    "scripts/lib/state-machine.js",
    "scripts/lib/plan-check.js",
    "scripts/lib/verification-lifecycle.js",
    "scripts/lib/run-gate.js",
  ]) {
    const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.equal(
      source.includes("task-artifacts"),
      false,
      `${relative} must not depend on the generated task views`,
    );
  }
});

test("a dry run reports without writing", () => {
  const root = worktreeWithPlan(planText());
  const result = materializeTaskArtifacts({ worktree: root, dryRun: true });
  assert.deepEqual(
    result.tasks.map((task) => task.status),
    ["WOULD_CREATE"],
  );
  assert.equal(fs.existsSync(taskFile(root)), false);
});
