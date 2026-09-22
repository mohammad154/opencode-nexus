/**
 * PR9: guarded parallel execution end to end, over the real gates (no mocks).
 *
 * What these tests pin down:
 * - Two independent units can have their implementers run concurrently in lane
 *   worktrees, and the run still reaches COMPLETED through the ordinary chain:
 *   fresh pre-impact, scope lock, deterministic verification, one task review
 *   per unit bound to the parent's commit, the mandatory final review, and PR8
 *   convergence. The agent-call ledger is identical to a sequential run.
 * - The join rebases lane work onto the parent tip, so the parent's bindings are
 *   satisfied by construction rather than by exception.
 * - Every join guard refuses for real: work outside the unit's scope, a conflict
 *   with the parent branch, a lane with no finished implementer, a unit that
 *   shares files with an open lane, and abandoning work already joined. A
 *   refused join leaves the parent branch exactly where it was.
 * - `nexus lane join` runs inside the parent's IMPLEMENTING window without
 *   tripping control-plane tamper detection at VERIFYING (lane records live
 *   outside the protected tree).
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

function runState(root, runId = "lane") {
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pr9-lane-"));
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

  assert.equal(nx(root, "run", "init", "--run-id", "lane").status, 0);
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

/**
 * Implement one unit inside `dir` — the parent root in a sequential run, or a
 * lane worktree in a parallel one. The edits, the commit, and the handoff are
 * identical either way; only the directory differs.
 */
function implement(dir, unit, base) {
  const root = dir;
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
    path.join(root, ".opencode", "handoffs", "lane-implementer.json"),
    JSON.stringify(
      {
        schema_version: "1.1",
        run_id: "lane",
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
    path.join(root, ".opencode", "handoffs", "lane-reviewer.json"),
    JSON.stringify(
      {
        schema_version: "1.2",
        run_id: "lane",
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
    path.join(root, ".opencode", "handoffs", "lane-reviewer.json"),
    JSON.stringify(
      {
        schema_version: "1.2",
        run_id: "lane",
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
  const r = nx(root, "advance", "--json", "--run-id", "lane");
  const start = r.text.indexOf("{");
  return { status: r.status, report: start === -1 ? null : JSON.parse(r.text.slice(start)), raw: r.text };
}


/** The lane worktree path for a unit. */
function lanePath(root, unit) {
  const status = JSON.parse(nx(root, "lane", "status", "--json", "--run-id", "lane").stdout);
  const lane = status.lanes.find((entry) => entry.unit === unit);
  return lane ? lane.path : null;
}

function lanePlan(root, ...extra) {
  const r = nx(root, "lane", "plan", "--json", "--run-id", "lane", ...extra);
  return { status: r.status, plan: JSON.parse(r.stdout) };
}

test("two independent units implement concurrently in lanes and the run completes", () => {
  const { root, base } = project();

  // The wave comes from the plan's DAG and the units' file scopes.
  const { status: planStatus, plan } = lanePlan(root, "--max-concurrency", "2");
  assert.equal(planStatus, 0);
  assert.deepEqual(
    plan.wave.map((unit) => unit.id),
    ["unit-1", "unit-2"],
  );
  assert.equal(plan.parallel, true);

  // Both lanes open at the same parent tip — this is the concurrency.
  for (const unit of ["unit-1", "unit-2"]) {
    const started = nx(root, "lane", "start", "--unit", unit, "--run-id", "lane");
    assert.equal(started.status, 0, started.text);
  }
  const laneOne = lanePath(root, "unit-1");
  const laneTwo = lanePath(root, "unit-2");
  assert.ok(laneOne && laneTwo && laneOne !== laneTwo);
  assert.equal(git(laneOne, "rev-parse", "HEAD"), base);
  assert.equal(git(laneTwo, "rev-parse", "HEAD"), base);

  // Both implementers run against the same base, as they would in parallel.
  const laneOneCommit = implement(laneOne, "unit-1", base);
  const laneTwoCommit = implement(laneTwo, "unit-2", base);
  assert.notEqual(laneOneCommit, laneTwoCommit);
  // The parent branch has not moved yet.
  assert.equal(git(root, "rev-parse", "HEAD"), base);

  const status = JSON.parse(nx(root, "lane", "status", "--json", "--run-id", "lane").stdout);
  assert.deepEqual(
    status.lanes.map((lane) => lane.ready_to_join),
    [true, true],
  );

  // unit-1: the parent authorizes IMPLEMENTING, then the lane is joined.
  let step = advance(root);
  assert.equal(step.status, 0, step.raw);
  assert.equal(step.report.state, "IMPLEMENTING");
  assert.equal(step.report.stopped.dispatch.unit_or_task, "unit-1");
  let joined = nx(root, "lane", "join", "--unit", "unit-1", "--run-id", "lane");
  assert.equal(joined.status, 0, joined.text);
  assert.equal(git(root, "rev-parse", "HEAD"), laneOneCommit);

  // From here the parent runs its normal chain over the joined work.
  step = advance(root);
  assert.equal(step.status, 0, step.raw);
  assert.equal(step.report.stopped.dispatch.agent, "reviewer");
  review(root, "unit-1", base, git(root, "rev-parse", "HEAD"));
  step = advance(root);
  assert.equal(step.status, 0, step.raw);
  assert.equal(step.report.state, "IMPLEMENTING");
  assert.equal(step.report.stopped.dispatch.unit_or_task, "unit-2");

  // unit-2's lane was cut from the old base, so the join must rebase it.
  const unit2Base = runState(root).head_commit;
  joined = nx(root, "lane", "join", "--unit", "unit-2", "--run-id", "lane");
  assert.equal(joined.status, 0, joined.text);
  const joinReport = JSON.parse(nx(root, "lane", "status", "--json", "--run-id", "lane").stdout);
  const unit2Lane = joinReport.lanes.find((lane) => lane.unit === "unit-2");
  assert.equal(unit2Lane.status, "JOINED");
  assert.notEqual(unit2Lane.joined_commit, laneTwoCommit, "the lane work was rebased");
  assert.equal(unit2Lane.joined_onto, unit2Base);
  assert.deepEqual(unit2Lane.joined_files.sort(), ["src/avg.js", "tests/avg.test.js"]);
  assert.equal(git(root, "rev-parse", "HEAD"), unit2Lane.joined_commit);
  assert.equal(git(laneTwo, "rev-parse", "--abbrev-ref", "HEAD"), "nexus/lane/lane-unit-2");
  assert.equal(git(laneTwo, "rev-parse", "HEAD"), unit2Lane.joined_commit);

  // The handoff the parent consumes is bound to the parent's own commits, and
  // the lane's original bindings are preserved for audit.
  const handoff = JSON.parse(
    fs.readFileSync(path.join(root, ".opencode", "handoffs", "lane-implementer.json"), "utf8"),
  );
  assert.equal(handoff.base_commit, unit2Base);
  assert.equal(handoff.commit, unit2Lane.joined_commit);
  assert.equal(handoff.lane_provenance.lane_commit, laneTwoCommit);
  assert.equal(handoff.lane_provenance.rebased_onto, unit2Base);

  step = advance(root);
  assert.equal(step.status, 0, step.raw);
  assert.equal(step.report.stopped.dispatch.agent, "reviewer");
  review(root, "unit-2", unit2Base, git(root, "rev-parse", "HEAD"));

  step = advance(root);
  assert.equal(step.status, 0, step.raw);
  assert.equal(step.report.state, "FINAL_REVIEWING");
  assert.equal(step.report.stopped.dispatch.review_scope, "final");
  reviewFinal(root, base, git(root, "rev-parse", "HEAD"));
  step = advance(root);
  assert.equal(step.status, 0, step.raw);
  assert.equal(step.report.state, "COMPLETED", step.raw);

  const state = runState(root);
  // Every unit still earned its own approved task review, and convergence holds.
  assert.deepEqual(
    state.task_history.map((entry) => entry.id),
    ["unit-1", "unit-2"],
  );
  const trace = nx(root, "trace", "--json", "--run-id", "lane");
  assert.equal(trace.status, 0, trace.text);
  assert.equal(JSON.parse(trace.stdout).summary.converged, true);

  // Parallelism buys wall-clock, never a cheaper review: the agent-call ledger
  // is exactly what the same plan spends sequentially (see the identical
  // assertion in tests/convergence-e2e.test.js) — 2 implementers, 2 task
  // reviewers, 1 final reviewer, and the same accounting around them.
  assert.equal(state.agent_calls_used, 6);

  // Both units' work is really in the branch.
  assert.match(fs.readFileSync(path.join(root, "src", "sum.js"), "utf8"), /total > max/);
  assert.match(fs.readFileSync(path.join(root, "src", "avg.js"), "utf8"), /mean > max/);
  // Lane worktrees never became part of the parent's history.
  assert.equal(git(root, "log", "--oneline", "--", ".opencode/lanes"), "");
});

test("a lane that leaves its scope is refused and the parent branch does not move", () => {
  const { root, base } = project();
  assert.equal(nx(root, "lane", "start", "--unit", "unit-2", "--run-id", "lane").status, 0);
  const lane = lanePath(root, "unit-2");

  // The lane implementer edits a file unit-2 does not own.
  implement(lane, "unit-2", base);
  fs.writeFileSync(path.join(lane, "src", "sum.js"), "export const sneaked = true;\n");
  git(lane, "add", "src/sum.js");
  git(lane, "commit", "-m", "unit-2: also touch sum");

  const joined = nx(root, "lane", "join", "--unit", "unit-2", "--run-id", "lane");
  assert.equal(joined.status, 3, joined.text);
  assert.match(joined.text, /changed files outside its scope: src\/sum\.js/);
  assert.equal(git(root, "rev-parse", "HEAD"), base, "the parent branch is untouched");
  assert.equal(
    JSON.parse(nx(root, "lane", "status", "--json", "--run-id", "lane").stdout).lanes[0].status,
    "RUNNING",
  );
});

test("a lane that conflicts with the parent branch is refused, never auto-resolved", () => {
  const { root, base } = project();
  assert.equal(nx(root, "lane", "start", "--unit", "unit-2", "--run-id", "lane").status, 0);
  const lane = lanePath(root, "unit-2");
  implement(lane, "unit-2", base);

  // The parent branch changes the same file the lane changed. Disjointness has
  // been violated by something outside the schedule's control.
  fs.writeFileSync(
    path.join(root, "src", "avg.js"),
    "export function avg(a, b) {\n  return (a + b) / 2; // parent edit\n}\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "parent: touch avg");
  const parentTip = git(root, "rev-parse", "HEAD");

  const joined = nx(root, "lane", "join", "--unit", "unit-2", "--run-id", "lane");
  assert.equal(joined.status, 3, joined.text);
  assert.match(joined.text, /file-disjointness guard did not hold/);
  assert.match(joined.text, /implement it sequentially/);
  assert.equal(git(root, "rev-parse", "HEAD"), parentTip, "the parent branch is untouched");
  // The aborted rebase left the lane usable rather than stranded mid-conflict:
  // still on its own branch, with no unmerged paths.
  assert.equal(git(lane, "rev-parse", "--abbrev-ref", "HEAD"), "nexus/lane/lane-unit-2");
  assert.equal(
    git(lane, "status", "--porcelain")
      .split(/\r?\n/)
      .filter((line) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(line)).length,
    0,
  );
});

test("a join the parent never authorized is rejected at the parent's gate", () => {
  // The anti-launder property: the join can rebase and re-bind, but it cannot
  // make the parent accept work the parent did not authorize at that tip. Here
  // the lane is joined *before* the parent authorizes IMPLEMENTING, so the
  // handoff's base_commit is the old tip while the authorization records the new
  // one, and the unchanged VERIFYING binding refuses it.
  const { root, base } = project();
  assert.equal(nx(root, "lane", "start", "--unit", "unit-2", "--run-id", "lane").status, 0);
  const lane = lanePath(root, "unit-2");
  implement(lane, "unit-2", base);

  const joined = nx(root, "lane", "join", "--unit", "unit-2", "--run-id", "lane");
  assert.equal(joined.status, 0, joined.text);
  const handoff = JSON.parse(
    fs.readFileSync(path.join(root, ".opencode", "handoffs", "lane-implementer.json"), "utf8"),
  );
  assert.equal(handoff.base_commit, base);

  // The parent now authorizes unit-1 (not unit-2) at a tip that already contains
  // the joined work, so nothing about this handoff matches the authorization.
  const step = advance(root);
  const state = runState(root);
  assert.equal(state.state, "IMPLEMENTING");
  assert.notEqual(state.head_commit, handoff.base_commit);
  // Advance refuses to feed it to the gate at all, and says why.
  assert.equal(step.report.stopped.boundary, "AGENT");
  assert.equal(step.report.stopped.handoff_state, "BASE_NOT_CURRENT_AUTHORIZATION");
  assert.notEqual(state.state, "VERIFYING");
});

test("joined lane work cannot be replayed into a second authorization", () => {
  const { root, base } = project();
  assert.equal(nx(root, "lane", "start", "--unit", "unit-1", "--run-id", "lane").status, 0);
  const lane = lanePath(root, "unit-1");
  implement(lane, "unit-1", base);
  assert.equal(advance(root).status, 0);
  assert.equal(nx(root, "lane", "join", "--unit", "unit-1", "--run-id", "lane").status, 0);

  // The parent consumes it once.
  const step = advance(root);
  assert.equal(step.status, 0, step.raw);
  assert.equal(step.report.stopped.dispatch.agent, "reviewer");

  // A second join is refused outright: the lane's work is already in the parent.
  const again = nx(root, "lane", "join", "--unit", "unit-1", "--run-id", "lane");
  assert.equal(again.status, 3, again.text);
  assert.match(again.text, /already joined/);

  // And the handoff still sitting on disk cannot be consumed a second time.
  const replay = advance(root);
  assert.equal(replay.report.stopped.dispatch.agent, "reviewer");
  assert.equal(runState(root).state, "REVIEWING");
});

test("a lane with no finished implementer cannot be joined", () => {
  const { root } = project();
  assert.equal(nx(root, "lane", "start", "--unit", "unit-1", "--run-id", "lane").status, 0);
  const joined = nx(root, "lane", "join", "--unit", "unit-1", "--run-id", "lane");
  assert.equal(joined.status, 3, joined.text);
  assert.match(joined.text, /no implementer handoff to join/);
});

test("lanes refuse units that share scope, and refuse to abandon joined work", () => {
  const { root, base } = project();
  // A lane is only opened for a unit the schedule allows.
  assert.equal(nx(root, "lane", "start", "--unit", "unit-1", "--run-id", "lane").status, 0);
  const again = nx(root, "lane", "start", "--unit", "unit-1", "--run-id", "lane");
  assert.equal(again.status, 3, again.text);
  assert.match(again.text, /already exists with status RUNNING/);

  const unknown = nx(root, "lane", "start", "--unit", "unit-9", "--run-id", "lane");
  assert.equal(unknown.status, 3, unknown.text);
  assert.match(unknown.text, /not in the current lane wave/);

  // Abandoning an open lane is allowed and says plainly that work remains.
  const aborted = nx(root, "lane", "abort", "--unit", "unit-1", "--run-id", "lane");
  assert.equal(aborted.status, 0, aborted.text);
  assert.match(aborted.text, /must still be completed/);
  // PR8's convergence gate is what makes that statement enforceable.
  const trace = nx(root, "trace", "--json", "--run-id", "lane");
  assert.equal(trace.status, 3);

  // A joined lane cannot be abandoned: its work is in the parent branch.
  assert.equal(nx(root, "lane", "start", "--unit", "unit-2", "--run-id", "lane").status, 0);
  const lane = lanePath(root, "unit-2");
  implement(lane, "unit-2", base);
  assert.equal(advance(root).status, 0);
  assert.equal(nx(root, "lane", "join", "--unit", "unit-2", "--run-id", "lane").status, 0);
  const late = nx(root, "lane", "abort", "--unit", "unit-2", "--run-id", "lane");
  assert.equal(late.status, 3, late.text);
  assert.match(late.text, /already joined/);
});
