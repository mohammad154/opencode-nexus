import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveNextAction,
  formatNextActionInjection,
} from "../../scripts/lib/next-action.js";
import { buildRunGateReminder } from "../../scripts/lib/run-gate.js";
import { sealProviderArtifact } from "../../scripts/lib/artifact-seal.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const bin = path.join(root, "bin", "nexus.js");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(worktree, args) {
  const result = spawnSync("git", args, {
    cwd: worktree,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Nexus Test",
      GIT_AUTHOR_EMAIL: "nexus-test@example.invalid",
      GIT_COMMITTER_NAME: "Nexus Test",
      GIT_COMMITTER_EMAIL: "nexus-test@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || "").trim();
}

function failedVerificationRun(t, { phase = "TASK", attempts = 0, overrides = {} } = {}) {
  const worktree = tempDir("nexus-next-repair-");
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src", "app.js"), "export const app = true;\n");
  git(worktree, ["init"]);
  git(worktree, ["add", "."]);
  git(worktree, ["commit", "-m", "fixture"]);
  const head = git(worktree, ["rev-parse", "HEAD"]);
  const artifact = sealProviderArtifact(
    {
      schema_version: "1.0",
      ok: false,
      results: [
        { id: "test", status: "FAILED", pass: false, exit_code: 1 },
      ],
      workspace_integrity_available: true,
      workspace_clean: true,
      timed_out: false,
    },
    head,
  );
  const verification = {
    status: "FAILED",
    phase,
    worktree_head: head,
    artifact_digest: artifact.artifact_digest,
    failure_reason: "VERIFICATION_FAILED",
    workspace_integrity_available: true,
    workspace_clean: true,
  };
  return {
    worktree,
    state: {
      run_id: `repair-${phase.toLowerCase()}`,
      state: phase === "FINAL" ? "FINAL_VERIFYING" : "VERIFYING",
      verification_status: "FAILED",
      verification,
      verification_repair_attempts: attempts,
      ...(phase === "FINAL"
        ? { final_verification: artifact }
        : { provider_verification: artifact }),
      ...overrides,
    },
  };
}

test("resolveNextAction maps IMPLEMENTING → dispatch implementer", () => {
  const next = resolveNextAction({
    run_id: "r1",
    state: "IMPLEMENTING",
  });
  assert.equal(next.action, "dispatch_implementer");
  assert.equal(next.agent, "implementer");
  assert.match(next.instruction, /implementer/i);
  const text = formatNextActionInjection(next);
  assert.match(text, /REQUIRED_DISPATCH: implementer/);
});

test("resolveNextAction reconciles a stale IMPLEMENTING worktree binding", () => {
  const worktree = tempDir("nexus-next-binding-");
  try {
    fs.writeFileSync(path.join(worktree, "app.js"), "export const app = true;\n");
    git(worktree, ["init"]);
    git(worktree, ["add", "."]);
    git(worktree, ["commit", "-m", "fixture"]);
    const branch = git(worktree, ["branch", "--show-current"]);
    const next = resolveNextAction(
      {
        run_id: "stale-binding",
        state: "IMPLEMENTING",
        head_commit: "stale-head",
        branch,
      },
      { worktree },
    );
    assert.equal(next.action, "reconcile");
    assert.equal(next.agent, null);
    assert.equal(next.continuation.mode, "MANUAL");
    assert.match(next.instruction, /HEAD.*does not match|binding/i);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("resolveNextAction attaches centralized restart-safe continuation modes", () => {
  const cases = [
    [{ state: "CREATED" }, { mode: "AUTO", resume_on: null }],
    [
      { state: "BRAINSTORMING", planning_mode: "standard" },
      { mode: "AWAIT_AGENT", resume_on: "plan_advisor_handoff" },
    ],
    [{ state: "IMPLEMENTING" }, { mode: "AWAIT_AGENT", resume_on: "implementer_handoff" }],
    [{ state: "REVIEWING" }, { mode: "AWAIT_AGENT", resume_on: "reviewer_handoff" }],
    [{ state: "WAITING_FOR_USER" }, { mode: "AWAIT_USER", resume_on: "user_answer" }],
    [
      { state: "VERIFYING", verification_status: "FAILED", verification: { phase: "TASK", status: "FAILED" } },
      { mode: "MANUAL", resume_on: "repair" },
    ],
    [
      { state: "IMPLEMENTING", agent_calls_used: 23, agent_call_budget: { max_calls: 23 } },
      { mode: "MANUAL", resume_on: "repair" },
    ],
    [{ state: "BLOCKED" }, { mode: "MANUAL", resume_on: "repair" }],
    [{ state: "UNKNOWN" }, { mode: "MANUAL", resume_on: null }],
    [{ state: "FAILED" }, { mode: "MANUAL", resume_on: null }],
    [{ state: "COMPLETED" }, { mode: "FINISH", resume_on: null }],
  ];

  for (const [state, continuation] of cases) {
    const next = resolveNextAction({ run_id: "continuation-test", ...state });
    assert.deepEqual(next.continuation, continuation, state.state);
    if (continuation.mode === "AUTO") {
      assert.notEqual(next.continuation.mode, "AWAIT_USER", state.state);
    }
  }
});

test("resolveNextAction maps REVIEWING → dispatch reviewer", () => {
  const next = resolveNextAction({ run_id: "r1", state: "REVIEWING" });
  assert.equal(next.action, "dispatch_reviewer");
  assert.equal(next.agent, "reviewer");
});

test("resolveNextAction makes task and final verification status deterministic", () => {
  const cases = [
    ["VERIFYING", "TASK", "PENDING", "run_verification", "nexus verify"],
    ["VERIFYING", "TASK", "RUNNING", "resume_verification", "nexus verify --resume"],
    ["VERIFYING", "TASK", "TIMED_OUT", "resume_verification", "nexus verify --resume"],
    ["VERIFYING", "TASK", "FAILED", "report_failed_verification", "nexus run inspect"],
    ["VERIFYING", "TASK", "PASSED", "transition_to_reviewing", "nexus run transition --to REVIEWING"],
    ["FINAL_VERIFYING", "FINAL", "PENDING", "run_verification", "nexus verify"],
    ["FINAL_VERIFYING", "FINAL", "TIMED_OUT", "resume_verification", "nexus verify --resume"],
    ["FINAL_VERIFYING", "FINAL", "FAILED", "report_failed_verification", "nexus run inspect"],
    ["FINAL_VERIFYING", "FINAL", "PASSED", "transition_to_completed", "nexus run transition --to COMPLETED"],
  ];
  for (const [state, phase, status, action, command] of cases) {
    const next = resolveNextAction({
      run_id: `next-${state}-${status}`,
      state,
      verification_status: status,
      verification: { status, phase },
    });
    assert.equal(next.action, action, `${state}/${status}`);
    assert.equal(next.command, command, `${state}/${status}`);
    assert.equal(next.agent, null, `${state}/${status}`);
  }
});

test("eligible task verification failures automatically re-enter fresh impact once", (t) => {
  const { worktree, state } = failedVerificationRun(t);
  const next = resolveNextAction(state, {
    worktree,
    current_head: state.verification.worktree_head,
  });
  assert.equal(next.action, "repair_verification");
  assert.equal(next.agent, null);
  assert.deepEqual(next.continuation, { mode: "AUTO", resume_on: null });
  assert.match(next.command, /TASK_IMPACT_READY/);
  assert.match(next.command, new RegExp(state.verification.artifact_digest));
  assert.match(next.instruction, /fresh impact/i);
});

test("eligible final verification failures use the same bounded task repair path", (t) => {
  const { worktree, state } = failedVerificationRun(t, { phase: "FINAL" });
  const next = resolveNextAction(state, {
    worktree,
    current_head: state.verification.worktree_head,
  });
  assert.equal(next.action, "repair_verification");
  assert.equal(next.agent, null);
  assert.match(next.instruction, /bounded automatic repair/i);
  assert.match(next.steps.join(" "), /phase=FINAL/);
});

test("verification repair exhaustion blocks instead of redispatching", (t) => {
  const { worktree, state } = failedVerificationRun(t, { attempts: 1 });
  const next = resolveNextAction(state, {
    worktree,
    current_head: state.verification.worktree_head,
  });
  assert.equal(next.action, "block_for_verification_repair");
  assert.equal(next.agent, null);
  assert.equal(next.continuation.mode, "MANUAL");
  assert.match(next.command, /VERIFICATION_REPAIR_EXHAUSTED/);
});

test("timeouts, unavailable evidence, and stale HEADs remain manual", (t) => {
  const timeout = failedVerificationRun(t, {
    overrides: {
      verification: {
        status: "FAILED",
        phase: "TASK",
        worktree_head: "stale",
        artifact_digest: "stale",
        failure_reason: "VERIFICATION_TIMED_OUT",
      },
    },
  });
  const next = resolveNextAction(timeout.state, { worktree: timeout.worktree });
  assert.equal(next.action, "report_failed_verification");
  assert.equal(next.continuation.mode, "MANUAL");
});

test("provider process errors remain manual even when the runner reports an exit code", (t) => {
  const { worktree, state } = failedVerificationRun(t);
  const artifact = sealProviderArtifact(
    {
      ok: false,
      results: [
        {
          id: "test",
          status: "FAILED",
          pass: false,
          exit_code: 1,
          error_code: "EPERM",
        },
      ],
      workspace_integrity_available: true,
      workspace_clean: true,
      timed_out: false,
    },
    state.verification.worktree_head,
  );
  state.provider_verification = artifact;
  state.verification.artifact_digest = artifact.artifact_digest;
  const next = resolveNextAction(state, {
    worktree,
    current_head: state.verification.worktree_head,
  });
  assert.equal(next.action, "report_failed_verification");
  assert.equal(next.continuation.mode, "MANUAL");
});

test("resolveNextAction does not reuse verification status from another phase", () => {
  const next = resolveNextAction({
    run_id: "phase-mismatch",
    state: "FINAL_VERIFYING",
    verification_status: "PASSED",
    verification: { status: "PASSED", phase: "TASK" },
  });
  assert.equal(next.action, "run_verification");
  assert.equal(next.command, "nexus verify");
  assert.deepEqual(next.continuation, { mode: "AUTO", resume_on: null });
});

test("resolveNextAction maps PLANNED → pre_impact", () => {
  const next = resolveNextAction({ run_id: "r1", state: "PLANNED" });
  assert.equal(next.action, "pre_impact");
  assert.equal(next.agent, null);
  assert.match(next.command || "", /nexus impact/);
});

test("resolveNextAction maps TASK_IMPACT_READY → implementer after transition", () => {
  const next = resolveNextAction({
    run_id: "r1",
    state: "TASK_IMPACT_READY",
  });
  assert.equal(next.agent, "implementer");
  assert.equal(next.action, "transition_then_dispatch");
});

test("resolveNextAction blocks an implementer dispatch when the agent-call budget is exhausted", () => {
  for (const state of ["TASK_IMPACT_READY", "IMPLEMENTING"]) {
    const next = resolveNextAction({
      run_id: "budget-stop",
      state,
      agent_calls_used: 23,
      agent_call_budget: { max_calls: 23 },
    });
    assert.equal(next.action, "block_for_agent_budget", state);
    assert.equal(next.agent, null, state);
    assert.match(next.instruction, /do not Task-dispatch/i);
  }
});

test("resolveNextAction blocks reviewer redispatch after the fix-loop cap", () => {
  const next = resolveNextAction({
    run_id: "fix-loop-stop",
    state: "REVIEWING",
    current_unit: "unit-1",
    pending_review_unit: "unit-1",
    fix_loop_attempts: { "unit-1": 3 },
    last_review_handoff: { verdict: "REQUEST_CHANGES", unit_or_task: "unit-1" },
  });
  assert.equal(next.action, "block_for_fix_loop");
  assert.equal(next.agent, null);
  assert.equal(next.continuation.mode, "MANUAL");
  assert.match(next.instruction, /do not dispatch another reviewer or implementer/i);
});

test("resolveNextAction with no state → init_run", () => {
  const next = resolveNextAction(null);
  assert.equal(next.action, "init_run");
});

test("BRAINSTORMING without plan asks to write plan", () => {
  const wt = tempDir("nexus-next-plan-");
  const next = resolveNextAction(
    { run_id: "r1", state: "BRAINSTORMING" },
    { worktree: wt },
  );
  assert.equal(next.action, "write_plan");
  fs.rmSync(wt, { recursive: true, force: true });
});

test("BRAINSTORMING standard planning dispatches the plan advisor first", () => {
  const next = resolveNextAction({
    run_id: "r-advisor",
    state: "BRAINSTORMING",
    planning_mode: "standard",
  });
  assert.equal(next.action, "dispatch_plan_advisor");
  assert.equal(next.agent, "plan-advisor");
  assert.match(next.instruction, /read-only/i);
});

test("BRAINSTORMING with execution units requests plan-check", (t) => {
  const wt = tempDir("nexus-next-plan-check-");
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  const plan = path.join(wt, ".opencode", "plans", "PLAN.md");
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, "# Plan\n\n### Execution Unit 1: behavior\n");
  const next = resolveNextAction(
    { run_id: "r-plan-check", state: "BRAINSTORMING", planning_mode: "compact" },
    { worktree: wt },
  );
  assert.equal(next.action, "plan_check");
  assert.match(next.command || "", /transition .*--plan-check/);
});

test("BRAINSTORMING retries plan-check after a failed report", (t) => {
  const wt = tempDir("nexus-next-plan-check-failed-");
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  const plan = path.join(wt, ".opencode", "plans", "PLAN.md");
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, "# Plan\n\n### Execution Unit 1: behavior\n");
  const next = resolveNextAction(
    {
      run_id: "r-plan-check-failed",
      state: "BRAINSTORMING",
      planning_mode: "compact",
      plan_check: { ok: false, errors: [{ code: "MISSING_ACCEPTANCE" }] },
    },
    { worktree: wt },
  );
  assert.equal(next.action, "plan_check");
});

test("BRAINSTORMING with any PLAN.md requests integrated plan-check", () => {
  const wt = tempDir("nexus-next-hasplan-");
  const plan = path.join(wt, ".opencode", "plans", "PLAN.md");
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, "# Plan\n");
  const next = resolveNextAction(
    { run_id: "r1", state: "BRAINSTORMING" },
    { worktree: wt },
  );
  assert.equal(next.action, "plan_check");
  assert.match(next.command || "", /transition .*--plan-check/);
  fs.rmSync(wt, { recursive: true, force: true });
});

test("REVIEWING distinguishes single-unit reuse from multi-unit final review", () => {
  const single = resolveNextAction({
    run_id: "r-single",
    state: "REVIEWING",
    execution_units: [{ id: "unit-1" }],
  });
  assert.match(single.instruction, /reuse/i);

  const multi = resolveNextAction({
    run_id: "r-multi",
    state: "REVIEWING",
    execution_units: [{ id: "unit-1" }, { id: "unit-2" }],
  });
  assert.match(multi.instruction, /FINAL_REVIEWING/i);
  assert.doesNotMatch(multi.instruction, /single unit.*reuse/i);
});

test("REVIEWING uses plan-check units when runtime unit aliases are absent", () => {
  const units = [{ id: "unit-1" }, { id: "unit-2" }, { id: "unit-3" }];
  const next = resolveNextAction({
    run_id: "r-plan-count",
    state: "REVIEWING",
    execution_units: null,
    units: null,
    plan_check: { unit_count: 3, execution_units: units, tasks: units },
  });
  assert.match(next.instruction, /FINAL_REVIEWING/i);
  assert.doesNotMatch(next.instruction, /single unit.*reuse/i);
});

test("next action repairs an automatically derived budget from plan-check units", () => {
  const units = [{ id: "unit-1" }, { id: "unit-2" }, { id: "unit-3" }];
  const next = resolveNextAction({
    run_id: "r-stale-budget",
    state: "IMPLEMENTING",
    execution_units: null,
    units: null,
    task_count: null,
    plan_check: { unit_count: 3, execution_units: units, tasks: units },
    plan_advisor_calls: 1,
    agent_calls_used: 6,
    agent_call_budget: {
      source: "v5-default-workflow",
      units: 1,
      max_calls: 6,
      derived_max_calls: 6,
    },
  });
  assert.equal(next.action, "dispatch_implementer");
});

test("buildRunGateReminder includes Nexus Next Action", () => {
  const text = buildRunGateReminder({
    state: "IMPLEMENTING",
    run_id: "demo",
  });
  assert.match(text, /Nexus Next Action/);
  assert.match(text, /REQUIRED_DISPATCH: implementer/);
});

test("buildRunGateReminder keeps a pending verification run out of reviewer dispatch", () => {
  const text = buildRunGateReminder({
    state: "VERIFYING",
    run_id: "verify-pending",
    verification_status: "PENDING",
    verification: { phase: "TASK", status: "PENDING" },
  });
  assert.match(text, /Do not .*dispatch a reviewer/i);
  assert.match(text, /nexus verify/);
  assert.match(text, /run_verification/);
});

test("buildRunGateReminder exposes eligible verification repair as an automatic action", (t) => {
  const { worktree, state } = failedVerificationRun(t);
  const text = buildRunGateReminder(state, {
    worktree,
    current_head: state.verification.worktree_head,
  });
  assert.match(text, /fresh impact/i);
  assert.match(text, /repair_verification/);
  assert.doesNotMatch(text, /REQUIRED_DISPATCH/);
});

test("nexus next --json works with no run", () => {
  const wt = tempDir("nexus-next-cli-");
  const result = spawnSync(process.execPath, [bin, "next", "--json"], {
    encoding: "utf8",
    cwd: wt,
    env: { ...process.env, NEXUS_WORKTREE: wt },
  });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.next.action, "init_run");
  fs.rmSync(wt, { recursive: true, force: true });
});

test("nexus run next aliases nexus next", () => {
  const wt = tempDir("nexus-run-next-");
  const result = spawnSync(process.execPath, [bin, "run", "next", "--json"], {
    encoding: "utf8",
    cwd: wt,
    env: { ...process.env, NEXUS_WORKTREE: wt },
  });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.next.action, "init_run");
  fs.rmSync(wt, { recursive: true, force: true });
});

test("nexus next reads active run state", () => {
  const wt = tempDir("nexus-next-active-");
  const runDir = path.join(wt, ".opencode", "runs", "demo");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "state.json"),
    JSON.stringify({
      schema_version: "1.0",
      run_id: "demo",
      state: "REVIEWING",
      workflow: "default",
      execution_mode: "delegated",
      transitions: [],
      updated_at: "2026-08-20T12:00:00.000Z",
    }),
  );
  const result = spawnSync(process.execPath, [bin, "next", "--json"], {
    encoding: "utf8",
    cwd: wt,
    env: { ...process.env, NEXUS_WORKTREE: wt },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const body = JSON.parse(result.stdout);
  assert.equal(body.next.agent, "reviewer");
  assert.equal(body.next.action, "dispatch_reviewer");
  fs.rmSync(wt, { recursive: true, force: true });
});

test("nexus next honors the active-run pointer over a newer run", () => {
  const wt = tempDir("nexus-next-pointer-");
  try {
    const runs = path.join(wt, ".opencode", "runs");
    fs.mkdirSync(path.join(runs, "older"), { recursive: true });
    fs.mkdirSync(path.join(runs, "newer"), { recursive: true });
    const state = (run_id, stateName, updated_at) => ({
      schema_version: "1.0",
      run_id,
      state: stateName,
      workflow: "default",
      execution_mode: "delegated",
      transitions: [],
      updated_at,
    });
    fs.writeFileSync(
      path.join(runs, "older", "state.json"),
      JSON.stringify(state("older", "REVIEWING", "2026-01-01T00:00:00.000Z")),
    );
    fs.writeFileSync(
      path.join(runs, "newer", "state.json"),
      JSON.stringify(state("newer", "BRAINSTORMING", "2026-09-18T00:00:00.000Z")),
    );
    fs.mkdirSync(path.join(wt, ".opencode"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".opencode", "active-run"), "older\n");

    const result = spawnSync(process.execPath, [bin, "next", "--json"], {
      encoding: "utf8",
      cwd: wt,
      env: { ...process.env, NEXUS_WORKTREE: wt },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.next.run_id, "older");
    assert.equal(body.next.action, "dispatch_reviewer");
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test("nexus next rejects a missing --run-id value", () => {
  const wt = tempDir("nexus-next-missing-flag-");
  try {
    const result = spawnSync(process.execPath, [bin, "next", "--json", "--run-id"], {
      encoding: "utf8",
      cwd: wt,
      env: { ...process.env, NEXUS_WORKTREE: wt },
    });
    assert.equal(result.status, 2);
    const body = JSON.parse(result.stderr);
    assert.match(body.error, /--run-id requires a value/);
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});
