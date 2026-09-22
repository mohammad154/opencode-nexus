/**
 * PR7: end-to-end advance over the real gates (no mocked CLI).
 *
 * Permanent regressions:
 * - One `nexus advance` call per agent boundary drives a whole single-unit run
 *   to COMPLETED, using the same gates as the step-by-step sequence.
 * - Advance stops at exactly two agent boundaries (implementer, reviewer) and
 *   never dispatches or fabricates their output.
 * - Deleting the reviewer's approval blocks completion: automation cannot
 *   substitute for the review.
 * - Append-only telemetry does not trip the control-plane snapshot, while any
 *   other change to protected runtime state still does.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isTelemetrySink } from "../scripts/lib/control-plane.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nexus = path.join(repoRoot, "bin", "nexus.js");
const roots = [];

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function sh(root, command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NEXUS_WORKTREE: root },
  });
  return {
    ...result,
    stdout: result.stdout?.toString("utf8") ?? "",
    stderr: result.stderr?.toString("utf8") ?? "",
  };
}

function git(root, ...args) {
  return String(sh(root, "git", args).stdout || "").trim();
}

function advance(root, extra = []) {
  const result = sh(root, process.execPath, [nexus, "advance", "--json", ...extra]);
  const text = `${result.stdout}${result.stderr}`;
  const start = text.indexOf("{");
  return {
    exit_code: result.status,
    report: start === -1 ? null : JSON.parse(text.slice(start)),
    raw: text,
  };
}

function runState(root, runId = "e2e") {
  return JSON.parse(
    fs.readFileSync(path.join(root, ".opencode", "runs", runId, "state.json"), "utf8"),
  );
}

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pr7-e2e-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      { name: "lab", version: "1.0.0", type: "module", scripts: { test: "node --test tests/*.test.js" } },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(root, "src", "sum.js"), "export function sum(a, b) {\n  return a + b;\n}\n");
  fs.writeFileSync(
    path.join(root, "tests", "sum.test.js"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { sum } from "../src/sum.js";',
      "",
      'test("sum adds", () => {',
      "  assert.equal(sum(1, 2), 3);",
      "});",
      "",
    ].join("\n"),
  );
  git(root, "init");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  git(root, "checkout", "-q", "-b", "feat/clamp");
  const base = git(root, "rev-parse", "HEAD");

  fs.mkdirSync(path.join(root, ".opencode", "plans"), { recursive: true });
  fs.mkdirSync(path.join(root, ".opencode", "handoffs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".opencode", "plans", "PLAN.md"),
    [
      "# Plan: clamp sum output",
      "",
      "- Planning mode: compact",
      `- Plan commit: ${base}`,
      "",
      "## Goal",
      "`sum` must clamp its result to a caller-provided maximum.",
      "",
      "## Non-goals",
      "- No other helper changes.",
      "",
      "## Execution Unit breakdown",
      "",
      "### Execution Unit 1: clamp the sum result",
      "- id: unit-1",
      "- user_outcome: callers get a clamped total instead of an overflowing one",
      "- independently_shippable: true",
      "- review_boundary: NONE",
      "- estimated_lines: 20",
      "- Evidence:",
      "  - `src/sum.js:1` current unclamped implementation",
      "- Scope:",
      "  - In: `src/sum.js`, `tests/sum.test.js`",
      "- Acceptance criteria:",
      "  - [ ] sum(a, b, max) returns max when a + b exceeds max",
      "- Verification gates:",
      "  1. npm test",
      "- STOP conditions:",
      "  - STOP if src/sum.js no longer exports sum.",
      "",
    ].join("\n"),
  );
  const init = sh(root, process.execPath, [nexus, "run", "init", "--run-id", "e2e"]);
  assert.equal(init.status, 0, init.stderr);
  return { root, base };
}

/** What the implementer would produce: a commit plus its handoff. */
function implement(root, base) {
  fs.writeFileSync(
    path.join(root, "src", "sum.js"),
    [
      "export function sum(a, b, max = Number.POSITIVE_INFINITY) {",
      "  const total = a + b;",
      "  return total > max ? max : total;",
      "}",
      "",
    ].join("\n"),
  );
  fs.appendFileSync(
    path.join(root, "tests", "sum.test.js"),
    ['test("sum clamps to max", () => {', "  assert.equal(sum(5, 5, 7), 7);", "});", ""].join("\n"),
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "unit-1: clamp sum");
  const commit = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(
    path.join(root, ".opencode", "handoffs", "e2e-implementer.json"),
    JSON.stringify(
      {
        schema_version: "1.1",
        run_id: "e2e",
        unit_or_task: "unit-1",
        agent: "implementer",
        base_commit: base,
        created_at: new Date().toISOString(),
        status: "DONE",
        commit,
        files_changed: ["src/sum.js", "tests/sum.test.js"],
        allowed_files: ["src/sum.js", "tests/sum.test.js"],
        tests: [{ name: "sum clamps to max", file: "tests/sum.test.js", status: "PASS" }],
        verification_gates: [{ id: "unit", cmd: "npm test", pass: true }],
        drift_check: { plan_commit: base, current_head: commit, pass: true },
        impact: { risk: "MEDIUM", verified: true, callers_checked: ["tests/sum.test.js"] },
        notes_for_reviewer: "max defaults to Infinity so two-arg calls are unchanged",
      },
      null,
      2,
    ),
  );
  return commit;
}

/** What the reviewer would produce for the current HEAD. */
function review(root, base, commit) {
  fs.writeFileSync(
    path.join(root, ".opencode", "handoffs", "e2e-reviewer.json"),
    JSON.stringify(
      {
        schema_version: "1.2",
        run_id: "e2e",
        unit_or_task: "unit-1",
        agent: "reviewer",
        base_commit: base,
        created_at: new Date().toISOString(),
        verdict: "APPROVED",
        review_scope: "task",
        reviewed_commit: commit,
        files_reviewed: ["src/sum.js", "tests/sum.test.js"],
        files_skipped: [],
        impact: { pass: true, risk: "MEDIUM" },
        acceptance: [
          {
            id: "AC-1",
            status: "PASS",
            evidence: [{ file: "src/sum.js", line: 3, reason: "clamps the total to max" }],
          },
        ],
        checks: [
          { category: "correctness", status: "PASS", evidence: "src/sum.js:3 clamp branch" },
          { category: "test_quality", status: "PASS", evidence: "tests/sum.test.js:9 asserts the clamp" },
          { category: "impact", status: "PASS", evidence: "the only caller is the test" },
        ],
        findings: [],
        adversarial_checks: [
          {
            hypothesis: "a negative max could invert the clamp",
            result: "PASS",
            evidence: "src/sum.js:3 returns max only when the total exceeds it",
          },
        ],
      },
      null,
      2,
    ),
  );
}

test("advance drives a single-unit run to COMPLETED with two agent boundaries", () => {
  const { root, base } = project();

  // 1. Plan exists (orchestrator work). One call runs plan-check, pre-impact and
  //    the IMPLEMENTING authorization, then stops for the implementer.
  const first = advance(root);
  assert.equal(first.exit_code, 0, first.raw);
  assert.equal(first.report.state, "IMPLEMENTING");
  assert.equal(first.report.stopped.boundary, "AGENT");
  assert.equal(first.report.stopped.dispatch.agent, "implementer");
  assert.deepEqual(first.report.stopped.dispatch.allowed_files, [
    "src/sum.js",
    "tests/sum.test.js",
  ]);
  assert.deepEqual(
    first.report.steps.map((step) => step.step),
    ["start_brainstorming", "plan_check_transition", "pre_impact", "authorize_implementing"],
  );
  assert.ok(first.report.steps.every((step) => step.ok));

  // Calling it again while the implementer is still owed changes nothing.
  const idle = advance(root);
  assert.equal(idle.report.steps_executed, 0);
  assert.equal(idle.report.stopped.boundary, "AGENT");
  assert.equal(idle.report.stopped.handoff_state, "ABSENT");

  // 2. Implementer answers. One call consumes the handoff, runs deterministic
  //    verification, authorizes REVIEWING and builds the review package.
  const commit = implement(root, base);
  const second = advance(root);
  assert.equal(second.exit_code, 0, second.raw);
  assert.equal(second.report.state, "REVIEWING");
  assert.deepEqual(
    second.report.steps.map((step) => step.step),
    ["consume_implementer_handoff", "verify", "authorize_reviewing", "build_review_package"],
  );
  assert.equal(second.report.stopped.boundary, "AGENT");
  assert.equal(second.report.stopped.dispatch.agent, "reviewer");
  assert.equal(second.report.stopped.dispatch.review_scope, "task");
  const pkg = second.report.stopped.dispatch.review_package_path;
  assert.match(pkg, /^\.opencode\/reviews\//);
  assert.equal(fs.existsSync(path.join(root, pkg)), true);
  assert.equal(runState(root).verification_status, "PASSED");

  // Without the review, advance cannot complete the run.
  const blocked = advance(root);
  assert.equal(blocked.report.state, "REVIEWING");
  assert.equal(blocked.report.stopped.dispatch.agent, "reviewer");

  // 3. Reviewer approves. One call routes the approval, runs final verification
  //    and completes the run.
  review(root, base, commit);
  const third = advance(root);
  assert.equal(third.exit_code, 0, third.raw);
  assert.equal(third.report.state, "COMPLETED");
  // PR8: COMPLETED is only reachable because the reuse route recorded its task
  // approval in the traceability ledger, and every planned criterion is covered.
  const completed = runState(root);
  assert.deepEqual(
    completed.task_history.map((entry) => entry.id),
    ["unit-1"],
  );
  const trace = sh(root, process.execPath, [nexus, "trace", "--json", "--run-id", "e2e"]);
  const matrix = JSON.parse(trace.stdout);
  assert.equal(trace.status, 0, trace.stdout + trace.stderr);
  assert.equal(matrix.summary.converged, true);
  assert.equal(matrix.summary.criteria_covered, 1);
  assert.equal(matrix.rows[0].id, "unit-1/AC1");
  assert.deepEqual(
    third.report.steps.map((step) => step.step),
    ["consume_review_handoff", "verify", "authorize_completed"],
  );
  assert.equal(third.report.steps[0].route, "SINGLE_UNIT_REUSE");
  assert.equal(third.report.stopped.boundary, "DONE");

  const state = runState(root);
  assert.equal(state.state, "COMPLETED");
  assert.equal(state.last_review_handoff.verdict, "APPROVED");
  assert.equal(state.verification_status, "PASSED");
  // Advance consumed the agents' output; it never authored it.
  assert.equal(state.last_implementer_handoff.agent, "implementer");
  assert.equal(state.last_review_handoff.agent, "reviewer");
});

test("advance cannot complete a run whose review is missing", () => {
  const { root, base } = project();
  advance(root);
  implement(root, base);
  advance(root);
  // No reviewer handoff at all: every further call stays at the boundary.
  for (let i = 0; i < 3; i += 1) {
    const result = advance(root);
    assert.equal(result.report.state, "REVIEWING");
    assert.equal(result.report.stopped.boundary, "AGENT");
    assert.equal(result.report.stopped.dispatch.agent, "reviewer");
  }
  assert.notEqual(runState(root).state, "COMPLETED");
});

test("advance refuses a review that does not belong to the current code", () => {
  const { root, base } = project();
  advance(root);
  const commit = implement(root, base);
  advance(root);
  // A verdict for a different commit is not a verdict about this code.
  review(root, base, "a".repeat(40));
  const result = advance(root);
  assert.equal(result.report.state, "REVIEWING");
  assert.equal(result.report.stopped.boundary, "AGENT");
  assert.equal(result.report.stopped.handoff_state, "REVIEWED_COMMIT_NOT_CURRENT_HEAD");
  assert.notEqual(runState(root).state, "COMPLETED");
});

test("--dry-run reports the next deterministic step without running it", () => {
  const { root } = project();
  const before = runState(root).state;
  const result = advance(root, ["--dry-run"]);
  assert.equal(result.exit_code, 0);
  assert.equal(result.report.steps_executed, 0);
  assert.equal(result.report.stopped.reason_code, "DRY_RUN");
  assert.equal(result.report.stopped.planned_step.step, "start_brainstorming");
  assert.equal(runState(root).state, before);
});

test("advance telemetry records the collapsed round trips", () => {
  const { root, base } = project();
  advance(root);
  implement(root, base);
  advance(root);
  const metrics = fs
    .readFileSync(path.join(root, ".opencode", "runs", "e2e", "metrics.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "advance");
  assert.equal(metrics.length, 2);
  assert.equal(metrics[0].from_state, "CREATED");
  assert.equal(metrics[0].to_state, "IMPLEMENTING");
  assert.equal(metrics[0].advance_steps, 4);
  assert.ok(metrics[0].advance_commands >= 4);
  assert.equal(metrics[1].advance_boundary, "AGENT");
  assert.ok(metrics.every((event) => typeof event.advance_ms === "number"));
});

test("telemetry is outside the control-plane snapshot; everything else is not", () => {
  assert.equal(isTelemetrySink(".opencode/runs/e2e/metrics.jsonl"), true);
  assert.equal(isTelemetrySink(".opencode\\runs\\e2e\\metrics.jsonl"), true);
  for (const protectedPath of [
    ".opencode/runs/e2e/state.json",
    ".opencode/runs/e2e/verification.json",
    ".opencode/runs/e2e/metrics.jsonl.bak",
    ".opencode/runs/metrics.jsonl",
    ".opencode/plans/PLAN.md",
    ".opencode/impact/latest.json",
    ".opencode/tasks/task-1.md",
  ]) {
    assert.equal(isTelemetrySink(protectedPath), false, protectedPath);
  }
});

test("a protected runtime change after implementer dispatch still blocks VERIFYING", () => {
  const { root, base } = project();
  advance(root);
  implement(root, base);
  // Tamper with a protected artifact the gates actually read.
  fs.appendFileSync(path.join(root, ".opencode", "plans", "PLAN.md"), "\n- injected\n");
  const result = advance(root);
  assert.equal(result.exit_code, 3);
  assert.equal(result.report.stopped.reason_code, "GATE_REJECTED");
  assert.match(result.report.stopped.errors.join(" "), /protected Nexus runtime state changed/);
  assert.equal(runState(root).state, "BLOCKED");
});
