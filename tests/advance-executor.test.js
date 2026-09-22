/**
 * PR7.B: the advance executor is a thin shim over the existing gates.
 *
 * Permanent regressions:
 * - Every state change advance performs goes through `nexus run transition`;
 *   advance never writes run state, handoffs, or evidence itself.
 * - A rejected gate stops the chain with the gate's own errors and no retry.
 * - The chain is bounded by --max-steps and by the hard ceiling.
 * - --dry-run executes nothing.
 * - Telemetry records the collapsed round trips.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ADVANCE_MAX_STEPS,
  impactArtifactName,
  runAdvance,
} from "../scripts/lib/advance.js";
import { writeRunState } from "../scripts/lib/migrate-artifacts.js";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A worktree with persisted run state, a plan, and one commit. */
function fixture(stateOverrides = {}) {
  // stateOverrides may be a function of the created HEAD commit.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pr7-exec-"));
  roots.push(root);
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout?.trim();
  git("init");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(root, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-m", "one");
  // Run state records branch feat/pr7; the binding guard requires the checkout
  // to actually be on it.
  git("checkout", "-q", "-b", "feat/pr7");
  const head = git("rev-parse", "HEAD");
  fs.mkdirSync(path.join(root, ".opencode", "plans"), { recursive: true });
  fs.mkdirSync(path.join(root, ".opencode", "handoffs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opencode", "plans", "PLAN.md"), "# Plan\n");
  const overrides =
    typeof stateOverrides === "function" ? stateOverrides(head) : stateOverrides;
  const state = {
    schema_version: "1.0",
    run_id: "pr7",
    state: "PLANNED",
    plan_commit: "plan111",
    head_commit: "head111",
    branch: "feat/pr7",
    current_unit: "unit-1",
    execution_units: [
      {
        id: "unit-1",
        title: "one",
        allowed_files: ["src/one.js"],
        acceptance_criteria: ["one works"],
        depends_on: [],
      },
    ],
    transitions: [{ from: "BRAINSTORMING", to: "PLANNED", at: "2026-09-01T00:00:00.000Z" }],
    ...overrides,
  };
  writeRunState(root, state);
  return { root, state, head };
}

/** Records every CLI invocation; never touches the filesystem. */
function recorder(responses = {}) {
  const calls = [];
  const runner = (worktree, argv) => {
    calls.push(argv.join(" "));
    const key = Object.keys(responses).find((prefix) => argv.join(" ").startsWith(prefix));
    const response = key ? responses[key] : null;
    return {
      ok: response ? response.ok !== false : true,
      exit_code: response?.exit_code ?? (response && response.ok === false ? 3 : 0),
      stdout: response?.stdout ?? "{}",
      stderr: response?.stderr ?? "",
      ms: 1,
      argv,
    };
  };
  return { calls, runner };
}

test("advance plans but executes nothing in dry-run mode", () => {
  const { root } = fixture();
  const { calls, runner } = recorder();
  const result = runAdvance({ worktree: root, runId: "pr7", dryRun: true, runner });
  assert.deepEqual(calls, []);
  assert.equal(result.steps_executed, 0);
  assert.equal(result.stopped.reason_code, "DRY_RUN");
  assert.equal(result.stopped.planned_step.step, "pre_impact");
  assert.equal(result.ok, true);
});

test("a rejected gate stops the chain and never retries with other evidence", () => {
  const { root } = fixture();
  const { calls, runner } = recorder({
    impact: { ok: true },
    "run transition --to TASK_IMPACT_READY": {
      ok: false,
      exit_code: 3,
      stderr: JSON.stringify({ ok: false, errors: ["TASK_IMPACT_READY requires impact provider result"] }),
    },
  });
  const result = runAdvance({ worktree: root, runId: "pr7", runner });
  assert.equal(result.ok, false);
  assert.equal(result.steps_executed, 1);
  assert.equal(result.stopped.reason_code, "GATE_REJECTED");
  assert.deepEqual(result.stopped.errors, [
    "TASK_IMPACT_READY requires impact provider result",
  ]);
  // Exactly one impact run and one rejected transition: no second attempt.
  assert.equal(calls.filter((c) => c.startsWith("run transition")).length, 1);
  assert.equal(calls.filter((c) => c.startsWith("impact")).length, 1);
});

test("state changes only ever happen through the transition gate", () => {
  const { root } = fixture();
  const before = fs.readFileSync(
    path.join(root, ".opencode", "runs", "pr7", "state.json"),
    "utf8",
  );
  const { calls, runner } = recorder();
  runAdvance({ worktree: root, runId: "pr7", runner, maxSteps: 4 });
  // The fake runner performs no writes, so advance itself must not have either.
  assert.equal(
    fs.readFileSync(path.join(root, ".opencode", "runs", "pr7", "state.json"), "utf8"),
    before,
  );
  assert.equal(fs.existsSync(path.join(root, ".opencode", "handoffs", "pr7-implementer.json")), false);
  for (const call of calls) {
    assert.match(
      call,
      /^(run transition|run drift|run can-transition|impact|verify|review-package)\b/,
      `unexpected command: ${call}`,
    );
  }
});

test("the chain is bounded by --max-steps and the hard ceiling", () => {
  const { root } = fixture();
  const { calls, runner } = recorder();
  // maxSteps 0 is clamped to 1, and the ceiling is checked before each step.
  const result = runAdvance({ worktree: root, runId: "pr7", runner, maxSteps: 1 });
  assert.equal(result.steps_executed, 1);
  assert.ok(
    ["STEP_LIMIT_REACHED", "NO_PROGRESS"].includes(result.stopped.reason_code),
    result.stopped.reason_code,
  );
  assert.equal(calls.length > 0, true);

  assert.equal(ADVANCE_MAX_STEPS, 12);

  // A caller cannot raise the ceiling: an always-executable chain still stops at
  // the hard limit. `authorize_reviewing` keeps being named because the mock
  // runner never changes state, so the from_state differs each step only if the
  // run moves — here the NO_PROGRESS guard or the ceiling must stop it.
  const unbounded = runAdvance({
    worktree: root,
    runId: "pr7",
    runner,
    maxSteps: 9999,
  });
  assert.ok(unbounded.steps_executed <= ADVANCE_MAX_STEPS, String(unbounded.steps_executed));
  assert.ok(
    ["STEP_LIMIT_REACHED", "NO_PROGRESS", "GATE_REJECTED"].includes(
      unbounded.stopped.reason_code,
    ),
    unbounded.stopped.reason_code,
  );
});

test("pre_impact scopes the impact run to the unit and passes it to the gate", () => {
  const { root } = fixture();
  const { calls, runner } = recorder();
  runAdvance({ worktree: root, runId: "pr7", runner, maxSteps: 1 });
  const impactCall = calls.find((c) => c.startsWith("impact"));
  assert.match(impactCall, /--phase pre/);
  assert.match(impactCall, /--targets src\/one\.js/);
  const transition = calls.find((c) => c.startsWith("run transition"));
  assert.match(transition, /--to TASK_IMPACT_READY/);
  assert.match(transition, /--impact \.opencode\/impact\/pre-unit-1\.json/);
  assert.match(transition, /"current_unit":"unit-1"/);
});

test("implementing authorization measures drift instead of asserting it", () => {
  const { root } = fixture({ state: "TASK_IMPACT_READY" });
  const { calls, runner } = recorder({
    "run drift": {
      ok: true,
      stdout: JSON.stringify({
        schema_version: "1.0",
        drift: "NONE",
        reasons: [],
        commit_distance: 0,
        plan_commit: "plan111",
        current_head: "head111",
      }),
    },
  });
  runAdvance({ worktree: root, runId: "pr7", runner, maxSteps: 1 });
  const drift = calls.find((c) => c.startsWith("run drift"));
  assert.match(drift, /"plan_commit":"plan111"/);
  const transition = calls.find((c) => c.includes("--to IMPLEMENTING"));
  assert.match(transition, /--branch feat\/pr7/);
  assert.match(transition, /--acceptance one works/);
  assert.match(transition, /"drift":\{/);
  assert.match(transition, /"allowed_files":\["src\/one\.js"\]/);
});

test("a drift report that is not JSON stops the chain", () => {
  const { root } = fixture({ state: "TASK_IMPACT_READY" });
  const { runner } = recorder({ "run drift": { ok: true, stdout: "not json" } });
  const result = runAdvance({ worktree: root, runId: "pr7", runner });
  assert.equal(result.ok, false);
  assert.equal(result.stopped.reason_code, "GATE_REJECTED");
  assert.match(result.stopped.errors.join(" "), /drift report was not JSON/);
});

test("an unavailable eligibility precheck is an error, not a silent downgrade", () => {
  const { root, head } = fixture((commit) => ({
    state: "REVIEWING",
    review_package: {
      scope: "task",
      head_commit: commit,
      unit_or_task: "unit-1",
      digest_sha256: "d".repeat(64),
      path: ".opencode/reviews/pr7-task.md",
    },
    transitions: [{ from: "VERIFYING", to: "REVIEWING", at: "2026-09-01T10:00:00.000Z" }],
  }));
  fs.writeFileSync(
    path.join(root, ".opencode", "handoffs", "pr7-reviewer.json"),
    JSON.stringify({
      schema_version: "1.2",
      run_id: "pr7",
      created_at: "2026-09-01T10:00:05.000Z",
      verdict: "APPROVED",
      review_scope: "task",
      reviewed_commit: head,
    }),
  );
  const { calls, runner } = recorder({
    "run can-transition": { ok: false, exit_code: 2, stderr: "Unknown or missing command" },
  });
  const result = runAdvance({ worktree: root, runId: "pr7", runner });
  assert.equal(result.ok, false);
  assert.equal(result.steps[0].route, "PRECHECK_UNAVAILABLE");
  // It must not have fallen back to a transition on a broken precheck.
  assert.equal(calls.some((c) => c.includes("--to FINAL_REVIEWING")), false);
  assert.equal(calls.some((c) => c.includes("--to FINAL_VERIFYING") && c.startsWith("run transition")), false);
});

test("an ineligible reuse precheck falls back to the mandatory final review", () => {
  const { root, head } = fixture((commit) => ({
    state: "REVIEWING",
    review_package: {
      scope: "task",
      head_commit: commit,
      unit_or_task: "unit-1",
      digest_sha256: "d".repeat(64),
      path: ".opencode/reviews/pr7-task.md",
    },
    transitions: [{ from: "VERIFYING", to: "REVIEWING", at: "2026-09-01T10:00:00.000Z" }],
  }));
  fs.writeFileSync(
    path.join(root, ".opencode", "handoffs", "pr7-reviewer.json"),
    JSON.stringify({
      schema_version: "1.2",
      run_id: "pr7",
      created_at: "2026-09-01T10:00:05.000Z",
      verdict: "APPROVED",
      review_scope: "task",
      reviewed_commit: head,
    }),
  );
  const { calls, runner } = recorder({
    "run can-transition": { ok: false, exit_code: 3, stdout: JSON.stringify({ ok: false, errors: ["x"] }) },
  });
  const result = runAdvance({ worktree: root, runId: "pr7", runner, maxSteps: 1 });
  assert.equal(result.steps[0].route, "FINAL_REVIEW_REQUIRED");
  const fallback = calls.find((c) => c.includes("--to FINAL_REVIEWING"));
  assert.ok(fallback, "expected the mandatory final review route");
  assert.equal(fallback.includes("reuse_final_review"), false);
});

test("the next-unit route runs fresh impact before re-authorizing the loop", () => {
  const { root, head } = fixture((commit) => ({
    state: "REVIEWING",
    current_unit: "unit-1",
    execution_units: [
      { id: "unit-1", allowed_files: ["src/one.js"], acceptance_criteria: ["one works"], depends_on: [] },
      { id: "unit-2", allowed_files: ["src/two.js"], acceptance_criteria: ["two works"], depends_on: ["unit-1"] },
    ],
    review_package: {
      scope: "task",
      head_commit: commit,
      unit_or_task: "unit-1",
      digest_sha256: "d".repeat(64),
      path: ".opencode/reviews/pr7-task.md",
    },
    transitions: [{ from: "VERIFYING", to: "REVIEWING", at: "2026-09-01T10:00:00.000Z" }],
  }));
  fs.writeFileSync(
    path.join(root, ".opencode", "handoffs", "pr7-reviewer.json"),
    JSON.stringify({
      schema_version: "1.2",
      run_id: "pr7",
      created_at: "2026-09-01T10:00:05.000Z",
      verdict: "APPROVED",
      review_scope: "task",
      reviewed_commit: head,
    }),
  );
  const { calls, runner } = recorder();
  const result = runAdvance({ worktree: root, runId: "pr7", runner, maxSteps: 1 });
  assert.equal(result.steps[0].step, "consume_review_handoff");
  assert.equal(result.steps[0].route, "NEXT_UNIT");
  // Fresh impact for the *next* unit, never a reuse of the previous report.
  const impact = calls.find((c) => c.startsWith("impact"));
  assert.match(impact, /--targets src\/two\.js/);
  assert.match(impact, /--out \.opencode\/impact\/pre-unit-2\.json/);
  const transition = calls.find((c) => c.includes("--to TASK_IMPACT_READY"));
  assert.match(transition, /--review-handoff-file \.opencode\/handoffs\/pr7-reviewer\.json/);
  assert.match(transition, /"next_task":true/);
  assert.match(transition, /"current_unit":"unit-2"/);
  assert.match(transition, /--impact \.opencode\/impact\/pre-unit-2\.json/);
  // No reuse shortcut is ever requested while units remain.
  assert.equal(calls.some((c) => c.includes("reuse_final_review")), false);
});

test("a REQUEST_CHANGES verdict re-enters the bounded fix loop with fresh impact", () => {
  const { root, head } = fixture((commit) => ({
    state: "REVIEWING",
    current_unit: "unit-1",
    review_package: {
      scope: "task",
      head_commit: commit,
      unit_or_task: "unit-1",
      digest_sha256: "d".repeat(64),
      path: ".opencode/reviews/pr7-task.md",
    },
    transitions: [{ from: "VERIFYING", to: "REVIEWING", at: "2026-09-01T10:00:00.000Z" }],
  }));
  fs.writeFileSync(
    path.join(root, ".opencode", "handoffs", "pr7-reviewer.json"),
    JSON.stringify({
      schema_version: "1.2",
      run_id: "pr7",
      created_at: "2026-09-01T10:00:05.000Z",
      verdict: "REQUEST_CHANGES",
      review_scope: "task",
      reviewed_commit: head,
    }),
  );
  const { calls, runner } = recorder();
  const result = runAdvance({ worktree: root, runId: "pr7", runner, maxSteps: 1 });
  assert.equal(result.steps[0].route, "REQUEST_CHANGES");
  const transition = calls.find((c) => c.includes("--to TASK_IMPACT_READY"));
  assert.match(transition, /"planned_targets":\["src\/one\.js"\]/);
  assert.equal(transition.includes('"next_task"'), false);
  assert.match(calls.find((c) => c.startsWith("impact")), /--targets src\/one\.js/);
});

test("a traversal unit id cannot place an artifact outside the worktree", () => {
  const evil = "../../escape";
  assert.equal(impactArtifactName(evil), "pre-unit.json");
  assert.equal(impactArtifactName("unit-1"), "pre-unit-1.json");

  // The planner refuses the unit outright rather than silently renaming it.
  const { root } = fixture({
    execution_units: [
      { id: evil, allowed_files: ["src/one.js"], acceptance_criteria: ["works"], depends_on: [] },
    ],
    current_unit: evil,
  });
  const { calls, runner } = recorder();
  const result = runAdvance({ worktree: root, runId: "pr7", runner });
  assert.deepEqual(calls, []);
  assert.equal(result.stopped.reason_code, "UNSAFE_UNIT_ID");
});

test("the impact CLI keeps every destination inside the worktree", () => {
  const { root } = fixture();
  const escape = path.join(root, "..", `escaped-${path.basename(root)}.json`);
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/nexus-impact.js"),
      "--json",
      "--phase",
      "pre",
      "--targets",
      "src/one.js",
      "--out",
      escape,
      "--worktree",
      root,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /impact artifact path/);
  assert.equal(fs.existsSync(escape), false);
});

test("a step that succeeds without advancing the run stops the chain", () => {
  // The fake runner reports success but never changes state, so the resolver
  // keeps naming the same step.
  const { root } = fixture();
  const { calls, runner } = recorder();
  const result = runAdvance({ worktree: root, runId: "pr7", runner, maxSteps: 12 });
  assert.equal(result.ok, false);
  assert.equal(result.stopped.reason_code, "NO_PROGRESS");
  assert.equal(result.steps_executed, 1);
  // Exactly one attempt: no retry storm up to the step ceiling.
  assert.equal(calls.filter((c) => c.startsWith("impact")).length, 1);
});

test("telemetry records the collapsed round trips", () => {
  const { root } = fixture();
  const events = [];
  const { runner } = recorder();
  runAdvance({
    worktree: root,
    runId: "pr7",
    runner,
    maxSteps: 2,
    telemetry: { emit: (event) => events.push(event) },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "advance");
  assert.equal(events[0].run_id, "pr7");
  assert.equal(events[0].from_state, "PLANNED");
  // The mock runner never moves the run, so the chain stops after one step.
  assert.equal(events[0].advance_steps, 1);
  assert.ok(events[0].advance_commands >= 2);
  assert.equal(typeof events[0].advance_ms, "number");
  assert.equal(typeof events[0].advance_boundary, "string");
});

test("advance reports a missing run instead of creating one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pr7-norun-"));
  roots.push(root);
  const { calls, runner } = recorder();
  const result = runAdvance({ worktree: root, runId: "nope", runner });
  // Naming a run is the orchestrator's decision, so this is a boundary, not a
  // failure — but nothing may be executed or created.
  assert.equal(result.stopped.boundary, "SELF");
  assert.equal(result.stopped.reason_code, "NO_RUN");
  assert.deepEqual(calls, []);
  assert.equal(
    fs.existsSync(path.join(root, ".opencode", "runs", "nope", "state.json")),
    false,
  );
});
