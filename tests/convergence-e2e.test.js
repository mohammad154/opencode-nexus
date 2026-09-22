/**
 * PR8: convergence end to end, over the real gates (no mocked CLI).
 *
 * Permanent regressions:
 * - A 2-unit plan that implements and reviews both units still reaches
 *   COMPLETED: the convergence gate adds no false rejection.
 * - The same plan, with unit-2 silently abandoned and no `next_task` declared,
 *   cannot reach the final review — the exact hole PR8 closes. Before PR8 this
 *   run reached COMPLETED with `src/avg.js` untouched.
 * - `nexus trace` reports the ledger and exits 3 while a run has not converged.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nexus = path.join(repoRoot, "bin", "nexus.js");
const roots = [];

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function sh(root, command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NEXUS_WORKTREE: root },
  });
}
const git = (root, ...args) => String(sh(root, "git", args).stdout || "").trim();

function nx(root, ...args) {
  const r = sh(root, process.execPath, [nexus, ...args]);
  return { status: r.status, text: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

function runState(root, runId = "conv") {
  return JSON.parse(
    fs.readFileSync(path.join(root, ".opencode", "runs", runId, "state.json"), "utf8"),
  );
}

const ADVISOR = {
  schema_version: "1.0",
  agent: "plan-advisor",
  calls: 1,
  read_only: true,
  permission_profile: "read-only-bash-allowlist",
  plan_verdict: "KEEP",
  simpler_approach_available: false,
  units: [],
  missing_dependencies: [],
  missing_edge_cases: [],
  risk_misses: [],
  recommended_unit_count: 2,
  model: "openai/gpt-5-mini",
};

/** A two-unit project whose units touch disjoint helpers. */
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pr8-conv-"));
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
  fs.writeFileSync(path.join(root, "src", "avg.js"), "export function avg(a, b) {\n  return (a + b) / 2;\n}\n");
  fs.writeFileSync(
    path.join(root, "tests", "sum.test.js"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { sum } from "../src/sum.js";',
      "",
      'test("sum baseline", () => {',
      "  assert.equal(sum(1, 2), 3);",
      "});",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "tests", "avg.test.js"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { avg } from "../src/avg.js";',
      "",
      'test("avg baseline", () => {',
      "  assert.equal(avg(2, 4), 3);",
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
      "# Plan: clamp both helpers",
      "",
      "- Planning mode: standard",
      `- Plan commit: ${base}`,
      "",
      "## Goal",
      "Both helpers must clamp their result to a caller-provided maximum.",
      "",
      "## Requirements",
      "- R1: a caller can clamp a sum",
      "- R2: a caller can clamp an average",
      "",
      "## Non-goals",
      "- No other helper changes.",
      "",
      "## Plan Check Dispositions",
      "",
      "- code: MERGE_CANDIDATE",
      "  units: unit-1, unit-2",
      "  decision: KEEP_SEPARATE",
      "  reason_code: PUBLIC_CONTRACT",
      "  reason: sum and avg are separately versioned public helpers.",
      "",
      "## Execution Unit Justification",
      "",
      "Number of units: 2",
      "",
      "Why not fewer:",
      "- sum and avg are separately shipped public helpers with independent callers.",
      "",
      "Why not more:",
      "- tests stay with the behavior they prove.",
      "",
      "## Execution Unit breakdown",
      "",
      "### Execution Unit 1: clamp the sum result",
      "- id: unit-1",
      "- covers: R1",
      "- user_outcome: callers get a clamped total",
      "- independently_shippable: true",
      "- review_boundary: PUBLIC_CONTRACT",
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
      "### Execution Unit 2: clamp the average result",
      "- id: unit-2",
      "- covers: R2",
      "- user_outcome: callers get a clamped average",
      "- independently_shippable: true",
      "- review_boundary: PUBLIC_CONTRACT",
      "- estimated_lines: 20",
      "- Depends on: none",
      "- Evidence:",
      "  - `src/avg.js:1` current unclamped implementation",
      "- Scope:",
      "  - In: `src/avg.js`, `tests/avg.test.js`",
      "- Acceptance criteria:",
      "  - [ ] avg(a, b, max) returns max when the mean exceeds max",
      "- Verification gates:",
      "  1. npm test",
      "- STOP conditions:",
      "  - STOP if src/avg.js no longer exports avg.",
      "",
    ].join("\n"),
  );

  assert.equal(nx(root, "run", "init", "--run-id", "conv").status, 0);
  assert.equal(
    nx(
      root,
      "run",
      "transition",
      "--to",
      "BRAINSTORMING",
      "--json",
      JSON.stringify({ planning_mode: "standard", unit_count: 2, cohesive_unit: false, known_pattern: true, risk: "LOW" }),
    ).status,
    0,
  );
  const planned = nx(
    root,
    "run",
    "transition",
    "--to",
    "PLANNED",
    "--plan-check",
    "--json",
    JSON.stringify({
      planning_mode: "standard",
      plan_exists: true,
      cohesive_unit: false,
      known_pattern: true,
      risk: "LOW",
      unit_count: 2,
      plan_advisor: ADVISOR,
    }),
  );
  assert.equal(planned.status, 0, planned.text);
  return { root, base };
}

/** Implement one unit: edit its files, commit, and write its handoff. */
function implement(root, unit, base) {
  const files =
    unit === "unit-1"
      ? ["src/sum.js", "tests/sum.test.js"]
      : ["src/avg.js", "tests/avg.test.js"];
  if (unit === "unit-1") {
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
      ['test("sum clamps", () => {', "  assert.equal(sum(5, 5, 7), 7);", "});", ""].join("\n"),
    );
  } else {
    fs.writeFileSync(
      path.join(root, "src", "avg.js"),
      [
        "export function avg(a, b, max = Number.POSITIVE_INFINITY) {",
        "  const mean = (a + b) / 2;",
        "  return mean > max ? max : mean;",
        "}",
        "",
      ].join("\n"),
    );
    fs.appendFileSync(
      path.join(root, "tests", "avg.test.js"),
      ['test("avg clamps", () => {', "  assert.equal(avg(10, 10, 7), 7);", "});", ""].join("\n"),
    );
  }
  git(root, "add", ".");
  git(root, "commit", "-m", `${unit}: clamp`);
  const commit = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(
    path.join(root, ".opencode", "handoffs", "conv-implementer.json"),
    JSON.stringify(
      {
        schema_version: "1.1",
        run_id: "conv",
        unit_or_task: unit,
        agent: "implementer",
        base_commit: base,
        created_at: new Date().toISOString(),
        status: "DONE",
        commit,
        files_changed: files,
        allowed_files: files,
        tests: [{ name: `${unit} clamps`, file: files[1], status: "PASS" }],
        verification_gates: [{ id: "unit", cmd: "npm test", pass: true }],
        drift_check: { plan_commit: base, current_head: commit, pass: true },
        impact: { risk: "MEDIUM", verified: true, callers_checked: [files[1]] },
      },
      null,
      2,
    ),
  );
  return commit;
}

/** Review one unit at the current HEAD, reporting the plan's criterion id. */
function review(root, unit, base, commit, scope = "task") {
  const criterion =
    unit === "unit-1"
      ? "sum(a, b, max) returns max when a + b exceeds max"
      : "avg(a, b, max) returns max when the mean exceeds max";
  const files =
    unit === "unit-1"
      ? ["src/sum.js", "tests/sum.test.js"]
      : ["src/avg.js", "tests/avg.test.js"];
  fs.writeFileSync(
    path.join(root, ".opencode", "handoffs", "conv-reviewer.json"),
    JSON.stringify(
      {
        schema_version: "1.2",
        run_id: "conv",
        unit_or_task: unit,
        agent: "reviewer",
        base_commit: base,
        created_at: new Date().toISOString(),
        verdict: "APPROVED",
        review_scope: scope,
        reviewed_commit: commit,
        files_reviewed: files,
        files_skipped: [],
        impact: { pass: true, risk: "MEDIUM" },
        acceptance: [
          {
            id: `${unit}/AC1`,
            criterion,
            status: "PASS",
            evidence: [{ file: files[0], line: 3, reason: "clamps at max" }],
          },
        ],
        checks: [
          { category: "correctness", status: "PASS", evidence: `${files[0]}:3 clamp branch` },
          { category: "test_quality", status: "PASS", evidence: `${files[1]} asserts the clamp` },
          { category: "impact", status: "PASS", evidence: "the only caller is the test" },
        ],
        findings: [],
        adversarial_checks: [
          {
            hypothesis: "the default max could change two-argument behavior",
            result: "PASS",
            evidence: `${files[0]}:1 defaults max to Infinity`,
          },
        ],
      },
      null,
      2,
    ),
  );
}

/**
 * The whole-branch final review: it must report an acceptance result for every
 * criterion of every unit, using the plan's stable ids.
 */
function reviewFinal(root, base, commit) {
  const criteria = [
    {
      id: "unit-1/AC1",
      criterion: "sum(a, b, max) returns max when a + b exceeds max",
      file: "src/sum.js",
    },
    {
      id: "unit-2/AC1",
      criterion: "avg(a, b, max) returns max when the mean exceeds max",
      file: "src/avg.js",
    },
  ];
  fs.writeFileSync(
    path.join(root, ".opencode", "handoffs", "conv-reviewer.json"),
    JSON.stringify(
      {
        schema_version: "1.2",
        run_id: "conv",
        unit_or_task: "unit-2",
        agent: "reviewer",
        base_commit: base,
        created_at: new Date().toISOString(),
        verdict: "APPROVED",
        review_scope: "final",
        reviewed_commit: commit,
        files_reviewed: ["src/sum.js", "src/avg.js", "tests/sum.test.js", "tests/avg.test.js"],
        files_skipped: [],
        impact: { pass: true, risk: "MEDIUM" },
        acceptance: criteria.map((entry) => ({
          id: entry.id,
          criterion: entry.criterion,
          status: "PASS",
          evidence: [{ file: entry.file, line: 3, reason: "clamps at max" }],
        })),
        checks: [
          { category: "correctness", status: "PASS", evidence: "both helpers clamp" },
          { category: "test_quality", status: "PASS", evidence: "each helper has a clamp test" },
          { category: "impact", status: "PASS", evidence: "no shared caller between the helpers" },
          { category: "scope", status: "PASS", evidence: "only the planned files changed" },
          { category: "spec_fidelity", status: "PASS", evidence: "matches R1 and R2" },
        ],
        findings: [],
        adversarial_checks: [
          {
            hypothesis: "the two units could interact through a shared helper",
            result: "PASS",
            evidence: "src/sum.js and src/avg.js share no import",
          },
        ],
      },
      null,
      2,
    ),
  );
}

/** Drive advance until it stops, returning its report. */
function advance(root) {
  const r = nx(root, "advance", "--json", "--run-id", "conv");
  const start = r.text.indexOf("{");
  return { status: r.status, report: start === -1 ? null : JSON.parse(r.text.slice(start)), raw: r.text };
}

test("a two-unit run that covers every unit reaches COMPLETED", () => {
  const { root, base } = project();

  // unit-1
  let step = advance(root);
  assert.equal(step.status, 0, step.raw);
  assert.equal(step.report.stopped.dispatch.agent, "implementer");
  assert.equal(step.report.stopped.dispatch.unit_or_task, "unit-1");
  let commit = implement(root, "unit-1", base);
  step = advance(root);
  assert.equal(step.status, 0, step.raw);
  assert.equal(step.report.stopped.dispatch.agent, "reviewer");
  review(root, "unit-1", base, commit);

  // The approval routes to unit-2, not to the final review.
  step = advance(root);
  assert.equal(step.status, 0, step.raw);
  assert.equal(step.report.state, "IMPLEMENTING");
  assert.equal(step.report.stopped.dispatch.unit_or_task, "unit-2");

  // unit-2
  const unit2Base = runState(root).head_commit;
  commit = implement(root, "unit-2", unit2Base);
  step = advance(root);
  assert.equal(step.status, 0, step.raw);
  assert.equal(step.report.stopped.dispatch.agent, "reviewer");
  review(root, "unit-2", unit2Base, commit);

  // Last unit approved: the mandatory multi-unit final review is next.
  step = advance(root);
  assert.equal(step.status, 0, step.raw);
  assert.equal(step.report.state, "FINAL_REVIEWING");
  assert.equal(step.report.stopped.dispatch.agent, "reviewer");
  assert.equal(step.report.stopped.dispatch.review_scope, "final");

  reviewFinal(root, base, git(root, "rev-parse", "HEAD"));
  step = advance(root);
  assert.equal(step.status, 0, step.raw);
  assert.equal(step.report.state, "COMPLETED", step.raw);

  const state = runState(root);
  assert.deepEqual(
    state.task_history.map((entry) => entry.id),
    ["unit-1", "unit-2"],
  );

  const trace = nx(root, "trace", "--json", "--run-id", "conv");
  assert.equal(trace.status, 0, trace.text);
  const matrix = JSON.parse(trace.stdout);
  assert.equal(matrix.summary.converged, true);
  assert.deepEqual(
    matrix.rows.map((row) => row.id),
    ["unit-1/AC1", "unit-2/AC1"],
  );
  assert.deepEqual(
    matrix.rows.map((row) => row.status),
    ["COVERED", "COVERED"],
  );
  // Reviewers reported the plan's own ids, so nothing was matched by position.
  assert.equal(matrix.summary.criteria_positional_match, 0);
  assert.equal(matrix.summary.requirements_covered, 2);
  // Both helpers actually changed.
  assert.match(fs.readFileSync(path.join(root, "src", "avg.js"), "utf8"), /max/);
});

test("abandoning a planned unit blocks the final review", () => {
  const { root, base } = project();

  advance(root);
  const commit = implement(root, "unit-1", base);
  advance(root);
  review(root, "unit-1", base, commit);

  // The orchestrator skips unit-2 and asks for the final review directly.
  const attempt = nx(
    root,
    "run",
    "transition",
    "--to",
    "FINAL_REVIEWING",
    "--run-id",
    "conv",
    "--review-handoff-file",
    ".opencode/handoffs/conv-reviewer.json",
  );
  assert.equal(attempt.status, 3, attempt.text);
  assert.match(
    attempt.text,
    /FINAL_REVIEWING requires an approved task review for every planned execution unit; missing: unit-2/,
  );
  assert.equal(runState(root).state, "REVIEWING");

  // avg.js was never touched: the abandoned unit is real, not bookkeeping.
  assert.equal(
    fs.readFileSync(path.join(root, "src", "avg.js"), "utf8").includes("max"),
    false,
  );

  const trace = nx(root, "trace", "--json", "--run-id", "conv");
  assert.equal(trace.status, 3, trace.text);
  const matrix = JSON.parse(trace.stdout);
  assert.equal(matrix.summary.converged, false);
  assert.equal(matrix.summary.criteria_uncovered, 2);
  assert.match(matrix.errors.join(" "), /missing: unit-1, unit-2/);
});

test("a plan cannot declare a requirement no unit covers", () => {
  const { root } = project();
  const planPath = path.join(root, ".opencode", "plans", "PLAN.md");
  const plan = fs.readFileSync(planPath, "utf8").replace("- covers: R2\n", "");
  fs.writeFileSync(planPath, plan);
  const check = nx(root, "plan-check", "--json");
  assert.notEqual(check.status, 0, check.text);
  assert.match(check.text, /REQUIREMENT_NOT_COVERED/);
  assert.match(check.text, /requirement R2 is declared but no execution unit declares/);
});
