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

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const bin = path.join(root, "bin", "nexus.js");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
