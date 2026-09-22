import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  REVIEW_SELECTION_VERSION,
  buildReviewPackage,
  isSharedContractPath,
  sealedCommandsFromVerification,
} from "../scripts/lib/review-package.js";

const roots = [];

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd, args) {
  return String(
    spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .stdout || "",
  ).trim();
}

const SEALED = {
  ok: true,
  results: [
    { id: "test", command: "npm test", argv: ["npm", "test"], pass: true, status: "PASSED", duration_ms: 1200 },
    { id: "lint", command: "npm run lint", argv: ["npm", "run", "lint"], pass: true, status: "PASSED", duration_ms: 300 },
  ],
};

function planText(units) {
  const blocks = units.map((unit, index) =>
    [
      `### Execution Unit ${index + 1}: ${unit.title}`,
      `- id: ${unit.id}`,
      `- user_outcome: ${unit.outcome}`,
      "- independently_shippable: true",
      "- review_boundary: NONE",
      "- estimated_lines: 40",
      "- Evidence:",
      `  - \`${unit.files[0]}:1\` current implementation`,
      "- Scope:",
      `  - In: ${unit.files.map((f) => `\`${f}\``).join(", ")}`,
      "- Acceptance criteria:",
      `  - [ ] ${unit.criterion}`,
      "- Verification gates:",
      "  1. npm test",
      "- STOP conditions:",
      `  - STOP if ${unit.files[0]} is missing.`,
      "",
    ].join("\n"),
  );
  return [
    "# Plan: ingest",
    "- Planning mode: standard",
    "- Plan commit: 1234567",
    "",
    "## Goal",
    "Ingest archives correctly.",
    "",
    "## Non-goals",
    "- No backend redesign.",
    "",
    "## Context & Evidence",
    ...Array.from({ length: 200 }, (_, i) => `- filler context ${i}: ${"prose ".repeat(20)}`),
    "",
    "## Execution Unit Justification",
    `Number of units: ${units.length}`,
    "",
    "Why not fewer:",
    "- Independent slices.",
    "",
    "Why not more:",
    "- Tests stay with behavior.",
    "",
    "## Execution Unit breakdown",
    ...blocks,
  ].join("\n");
}

/** Two-unit run: unit-1 approved, unit-2 under review, shared index.js. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pr6-pkg-"));
  roots.push(root);
  git(root, ["init"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.mkdirSync(path.join(root, ".opencode", "plans"), { recursive: true });

  const long = (marker) =>
    Array.from({ length: 300 }, (_, i) => `export const ${marker}${i} = ${i};`).join("\n") + "\n";
  fs.writeFileSync(path.join(root, "src", "one.js"), long("a"));
  fs.writeFileSync(path.join(root, "src", "two.js"), long("b"));
  fs.writeFileSync(path.join(root, "src", "index.js"), "export const version = 1;\n");
  fs.writeFileSync(path.join(root, "tests", "two.test.js"), long("t"));
  fs.writeFileSync(path.join(root, "docs.md"), "# docs\n");
  fs.writeFileSync(
    path.join(root, ".opencode", "plans", "PLAN.md"),
    planText([
      {
        id: "unit-1",
        title: "Normalize one",
        outcome: "one normalizes",
        files: ["src/one.js"],
        criterion: "one normalizes input",
      },
      {
        id: "unit-2",
        title: "Validate two",
        outcome: "two validates",
        files: ["src/two.js", "tests/two.test.js"],
        criterion: "two rejects malformed input",
      },
    ]),
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  const runBase = git(root, ["rev-parse", "HEAD"]);

  // Rewrite every line so the fixture has a genuinely large diff.
  const touchAll = (marker, suffix) =>
    long(marker)
      .split("\n")
      .map((line) => (line ? `${line} // ${suffix}` : line))
      .join("\n");

  // unit-1 commit: touches src/one.js and the shared entry point.
  fs.writeFileSync(path.join(root, "src", "one.js"), touchAll("a", "unit-1"));
  fs.writeFileSync(path.join(root, "src", "index.js"), "export const version = 2;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "unit-1"]);
  const unit1 = git(root, ["rev-parse", "HEAD"]);

  // unit-2 commit: touches src/two.js, its test, docs, and the same entry point.
  fs.writeFileSync(path.join(root, "src", "two.js"), touchAll("b", "unit-2"));
  fs.writeFileSync(path.join(root, "tests", "two.test.js"), touchAll("t", "unit-2"));
  fs.writeFileSync(path.join(root, "src", "index.js"), "export const version = 3;\n");
  fs.writeFileSync(path.join(root, "docs.md"), "# docs\nupdated\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "unit-2"]);
  const head = git(root, ["rev-parse", "HEAD"]);

  const runState = {
    run_id: "pr6-pkg",
    current_unit: "unit-2",
    run_base_commit: runBase,
    head_commit: unit1,
    implementer_commit: head,
    acceptance_criteria: ["two rejects malformed input"],
    provider_verification: SEALED,
    final_verification: SEALED,
    post_impact: {
      ok: true,
      risk: "MEDIUM",
      confidence: 0.9,
      changed_files: ["src/two.js", "src/index.js", "tests/two.test.js"],
      direct_dependents: {
        "src/two.js": ["src/index.js", "src/one.js"],
        "src/index.js": ["src/one.js", "src/two.js", "tests/two.test.js"],
      },
      related_tests: ["tests/two.test.js"],
    },
    last_implementer_handoff: { notes_for_reviewer: "also tidied an unrelated helper" },
    task_history: [
      {
        id: "unit-1",
        verdict: "APPROVED",
        reviewed_commit: unit1,
        acceptance_criteria: ["one normalizes input"],
        review_handoff: {
          verdict: "APPROVED",
          review_scope: "task",
          run_id: "pr6-pkg",
          unit_or_task: "unit-1",
          reviewed_commit: unit1,
          acceptance: [
            { id: "AC-1", status: "PASS", evidence: [{ file: "src/one.js", line: 1, reason: "ok" }] },
          ],
          checks: [
            { category: "correctness", status: "PASS", evidence: "ok" },
            { category: "test_quality", status: "PASS", evidence: "ok" },
            { category: "impact", status: "PASS", evidence: "ok" },
          ],
          files_reviewed: ["src/one.js"],
        },
        review_package: {
          scope: "task",
          run_id: "pr6-pkg",
          unit_or_task: "unit-1",
          head_commit: unit1,
          digest_sha256: "a".repeat(64),
          acceptance_criteria: ["one normalizes input"],
        },
      },
    ],
  };
  return { root, runState, runBase, unit1, head };
}

function read(root, meta) {
  return fs.readFileSync(path.join(root, meta.path), "utf8");
}

test("task package is unit-focused and quotes no PLAN dump", () => {
  const f = fixture();
  const meta = buildReviewPackage(f.root, {
    scope: "task",
    runState: f.runState,
    headCommit: f.head,
  });
  const md = read(f.root, meta);

  for (const section of [
    "## Identity",
    "## Acceptance criteria",
    "## Execution unit under review",
    "## Changed files",
    "## Diff stat",
    "## Production files",
    "## Impact evidence (callers and related tests)",
    "## Sealed verification (authoritative, already executed)",
    "## Focused hunks",
    "## Implementer notes (unverified claims)",
    "## Inspect anything else yourself (read-only)",
  ]) {
    assert.ok(md.includes(section), `missing ${section}`);
  }

  // The current unit is derived from the normalized plan, not excerpted prose.
  assert.ok(md.includes("- id: `unit-2`"));
  assert.ok(md.includes("two validates"));
  assert.equal(md.includes("filler context 0"), false, "no PLAN excerpt dump");
  assert.equal(md.includes("Why not fewer"), false);
  assert.equal(md.includes("one normalizes"), false, "other units stay out of scope");

  // Sealed evidence is quoted with the consume-don't-replay instruction.
  assert.ok(md.includes("`npm test` → PASSED"));
  assert.match(md, /do not re-run to reconfirm/);
  assert.match(md, /adversarial_checks/);

  // Selection metadata records what was quoted and what was not.
  assert.equal(meta.selection.version, REVIEW_SELECTION_VERSION);
  assert.ok(meta.selection.hunk_files_included.includes("src/two.js"));
  assert.ok(meta.selection.whole_diff_bytes > 0);
  assert.equal(typeof meta.package_bytes, "number");
  assert.equal(typeof meta.generation_ms, "number");
  assert.deepEqual(
    meta.sealed_commands.map((step) => step.command),
    ["npm test", "npm run lint"],
  );
});

test("final package is integration-focused with bound approvals and hotspots", () => {
  const f = fixture();
  const meta = buildReviewPackage(f.root, {
    scope: "final",
    runState: f.runState,
    headCommit: f.head,
  });
  const md = read(f.root, meta);

  for (const section of [
    "## Run objective",
    "## Previous task review evidence",
    "## Cross-unit and shared files",
    "## Public / shared contract changes",
    "## Integration hotspots",
    "## Per-unit change ranges",
    "## Diff stat",
    "## Focused integration hunks",
  ]) {
    assert.ok(md.includes(section), `missing ${section}`);
  }
  assert.match(md, /review_evidence_bound: true/);
  assert.match(md, /files_changed_after_review:/);
  // src/index.js was changed by both units: it is the integration surface.
  assert.ok(meta.selection.integration.cross_unit_files.some((e) => e.file === "src/index.js"));
  assert.ok(meta.selection.integration.contract_files.includes("src/index.js"));
  assert.ok(meta.selection.integration.hotspots.includes("src/index.js"));
  assert.ok(meta.selection.integration.unit_ranges.length >= 2);
  // The whole-branch diff is available on demand rather than inlined.
  assert.ok(
    meta.selection.whole_diff_bytes > meta.package_bytes,
    `whole diff ${meta.selection.whole_diff_bytes} should exceed package ${meta.package_bytes}`,
  );
  assert.match(md, new RegExp(`git diff ${f.runBase} ${f.head}`));
  assert.equal(md.includes("filler context 0"), false);
});

test("selection is materially smaller than the whole diff and names omissions", () => {
  const f = fixture();
  const meta = buildReviewPackage(f.root, {
    scope: "task",
    runState: f.runState,
    headCommit: f.head,
    maxHunkBytes: 4_000,
    maxPerFileHunkBytes: 2_000,
  });
  const md = read(f.root, meta);
  assert.ok(meta.selection.hunk_bytes <= 4_000);
  assert.ok(meta.package_bytes < meta.selection.whole_diff_bytes);
  assert.ok(
    meta.selection.hunk_files_clipped.length + meta.selection.hunk_files_omitted.length > 0,
  );
  assert.match(md, /### Not quoted here/);
  // Every omission names the command that retrieves it.
  for (const entry of meta.selection.hunk_files_omitted) {
    assert.ok(md.includes(`git diff ${f.runBase ? meta.base_commit : ""} ${meta.head_commit} -- ${entry.file}`.trim()));
  }
});

test("package identity, digest binding, and acceptance stay unchanged", () => {
  const f = fixture();
  const meta = buildReviewPackage(f.root, {
    scope: "task",
    runState: f.runState,
    headCommit: f.head,
  });
  assert.equal(meta.schema_version, "1.0");
  assert.equal(meta.ok, true);
  assert.equal(meta.scope, "task");
  assert.equal(meta.run_id, "pr6-pkg");
  assert.equal(meta.unit_or_task, "unit-2");
  assert.equal(meta.base_commit, f.unit1);
  assert.equal(meta.head_commit, f.head);
  assert.equal(meta.run_base_commit, f.runBase);
  assert.deepEqual(meta.acceptance_criteria, ["two rejects malformed input"]);
  assert.ok(meta.changed_files.includes("src/two.js"));
  assert.ok(meta.production_files.includes("src/two.js"));
  assert.equal(meta.production_files.includes("tests/two.test.js"), false);
  const body = fs.readFileSync(path.join(f.root, meta.path), "utf8");
  assert.equal(createHash("sha256").update(body).digest("hex"), meta.digest_sha256);
  const sidecar = JSON.parse(fs.readFileSync(path.join(f.root, meta.meta_path), "utf8"));
  assert.deepEqual(sidecar, meta);
});

test("package generation emits review telemetry", () => {
  const f = fixture();
  const events = [];
  const meta = buildReviewPackage(f.root, {
    scope: "task",
    runState: f.runState,
    headCommit: f.head,
    telemetry: { emit: (event) => events.push(event) },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "review_package");
  assert.equal(events[0].run_id, "pr6-pkg");
  assert.equal(events[0].review_package_bytes, meta.package_bytes);
  assert.equal(typeof events[0].review_package_generation_ms, "number");
});

test("shared contract classification covers entry points, schemas, and manifests", () => {
  for (const file of [
    "src/index.js",
    "src/api/router.js",
    "schemas/thing.schema.json",
    "package.json",
    "db/migrations/001_init.sql",
    "openapi.yaml",
  ]) {
    assert.equal(isSharedContractPath(file), true, file);
  }
  for (const file of ["src/internal/helper.js", "tests/x.test.js", ".opencode/runs/x.json"]) {
    assert.equal(isSharedContractPath(file), false, file);
  }
  assert.deepEqual(
    sealedCommandsFromVerification(SEALED).map((step) => [step.command, step.pass]),
    [
      ["npm test", true],
      ["npm run lint", true],
    ],
  );
});
