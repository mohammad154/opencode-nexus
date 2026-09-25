/**
 * PR7.A: the advance planner is pure, table-driven, and fail-closed.
 *
 * Permanent regressions:
 * - Only allowlisted deterministic steps are executable; any other resolver
 *   action stops the chain with an explicit boundary.
 * - Orchestrator work (brainstorm, plan), user input, agent dispatch, and every
 *   documented repair remain boundaries: advance never does them.
 * - Prepared dispatches carry evidence, never a verdict.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ADVANCE_VERSION,
  BOUNDARIES,
  EXECUTABLE_STEPS,
  PROTECTED_BRANCHES,
  currentUnit,
  nextUnit,
  planAdvanceStep,
  preparedDispatch,
  reviewRoute,
  stateUnits,
} from "../scripts/lib/advance.js";

const UNITS = [
  {
    id: "unit-1",
    title: "one",
    user_outcome: "one works",
    allowed_files: ["src/one.js", "tests/one.test.js"],
    acceptance_criteria: ["one normalizes input"],
    depends_on: [],
    stop_conditions: ["STOP if src/one.js disappears"],
  },
  {
    id: "unit-2",
    title: "two",
    user_outcome: "two works",
    allowed_files: ["src/two.js"],
    acceptance_criteria: ["two rejects malformed input"],
    depends_on: ["unit-1"],
    stop_conditions: [],
  },
];

function stateFor(overrides = {}) {
  return {
    run_id: "pr7",
    state: "PLANNED",
    execution_units: UNITS,
    current_unit: "unit-1",
    branch: "feat/pr7",
    plan_commit: "plan111",
    head_commit: "head111",
    transitions: [{ from: "BRAINSTORMING", to: "PLANNED", at: "2026-09-01T00:00:00.000Z" }],
    ...overrides,
  };
}

function factsFor(state, overrides = {}) {
  const unit = currentUnit(state);
  return {
    worktree: "/tmp/pr7",
    state,
    head_commit: "head111",
    branch: state.branch,
    dirty_code: [],
    unit,
    unit_targets: unit?.allowed_files || [],
    unit_acceptance: unit?.acceptance_criteria || [],
    next_unit: nextUnit(state),
    unit_count: stateUnits(state).length,
    implementer_handoff: null,
    reviewer_handoff: null,
    review_package: null,
    ...overrides,
  };
}

test("the executable allowlist is the security boundary", () => {
  assert.equal(ADVANCE_VERSION, "nexus-advance/1");
  // Every executable step is deterministic: no step dispatches an agent or
  // writes evidence of its own.
  assert.deepEqual(EXECUTABLE_STEPS, [
    "start_brainstorming",
    "plan_check_transition",
    "pre_impact",
    "authorize_implementing",
    "consume_implementer_handoff",
    "verify",
    "verify_resume",
    "authorize_reviewing",
    "build_review_package",
    "consume_review_handoff",
    "authorize_completed",
  ]);
  assert.deepEqual(BOUNDARIES, ["SELF", "AGENT", "USER", "MANUAL", "DONE"]);
});

test("an unknown resolver action stops instead of guessing", () => {
  const state = stateFor();
  const plan = planAdvanceStep(
    { ok: true, action: "teleport_to_done", instruction: "???" },
    factsFor(state),
  );
  assert.equal(plan.execute, undefined);
  assert.equal(plan.stop.boundary, "MANUAL");
  assert.equal(plan.stop.reason_code, "UNSUPPORTED_ACTION");
});

test("orchestrator work, user input, and terminal states are boundaries", () => {
  const cases = [
    ["init_run", "CREATED", "SELF", "NO_RUN"],
    ["write_plan", "BRAINSTORMING", "SELF", "PLAN_REQUIRED"],
    ["brainstorm", "BRAINSTORMING", "SELF", "BRAINSTORM_REQUIRED"],
    ["await_user", "WAITING_FOR_USER", "USER", "AWAITING_USER_ANSWER"],
    ["done", "COMPLETED", "DONE", "COMPLETED"],
  ];
  for (const [action, stateName, boundary, code] of cases) {
    const state = stateFor({ state: stateName });
    const plan = planAdvanceStep({ ok: true, action, instruction: "x" }, factsFor(state));
    assert.equal(plan.execute, undefined, `${action} must not execute`);
    assert.equal(plan.stop.boundary, boundary, action);
    assert.equal(plan.stop.reason_code, code, action);
  }
});

test("documented repairs and blocks are never automated", () => {
  for (const action of [
    "repair_verification",
    "report_failed_verification",
    "reconcile",
    "block_for_agent_budget",
    "block_for_fix_loop",
    "block_for_verification_repair",
  ]) {
    const plan = planAdvanceStep(
      { ok: true, action, instruction: "fix it" },
      factsFor(stateFor({ state: "VERIFYING" })),
    );
    assert.equal(plan.execute, undefined, action);
    assert.equal(plan.stop.boundary, "MANUAL", action);
  }
});

test("CREATED starts brainstorming but BRAINSTORMING keeps the thinking with the orchestrator", () => {
  const created = planAdvanceStep(
    { ok: true, action: "brainstorm", instruction: "start" },
    factsFor(stateFor({ state: "CREATED" })),
  );
  assert.equal(created.execute.step, "start_brainstorming");
  assert.equal(created.execute.to, "BRAINSTORMING");
});

test("the deterministic gate chain maps to one step each", () => {
  const cases = [
    ["plan_check", "BRAINSTORMING", "plan_check_transition"],
    ["transition", "BRAINSTORMING", "plan_check_transition"],
    ["pre_impact", "PLANNED", "pre_impact"],
    ["transition_then_dispatch", "TASK_IMPACT_READY", "authorize_implementing"],
    ["run_verification", "VERIFYING", "verify"],
    ["resume_verification", "VERIFYING", "verify_resume"],
    ["transition_to_reviewing", "VERIFYING", "authorize_reviewing"],
    ["transition_to_completed", "FINAL_VERIFYING", "authorize_completed"],
  ];
  for (const [action, stateName, step] of cases) {
    const plan = planAdvanceStep(
      { ok: true, action, instruction: "x" },
      factsFor(stateFor({ state: stateName })),
    );
    assert.equal(plan.execute?.step, step, `${action} → ${step}`);
  }
});

test("pre_impact scopes impact to the unit's own files", () => {
  const plan = planAdvanceStep(
    { ok: true, action: "pre_impact", instruction: "x" },
    factsFor(stateFor({ state: "PLANNED" })),
  );
  assert.deepEqual(plan.execute.targets, ["src/one.js", "tests/one.test.js"]);
  assert.equal(plan.execute.unit, "unit-1");
  assert.equal(plan.execute.to, "TASK_IMPACT_READY");
});

test("a unit without scope or acceptance stops instead of inventing either", () => {
  const noScope = stateFor({
    state: "PLANNED",
    execution_units: [{ id: "unit-1", allowed_files: [], acceptance_criteria: ["a"] }],
  });
  const scopePlan = planAdvanceStep({ ok: true, action: "pre_impact" }, factsFor(noScope));
  assert.equal(scopePlan.stop.reason_code, "UNIT_WITHOUT_SCOPE");

  const noAcceptance = stateFor({
    state: "TASK_IMPACT_READY",
    execution_units: [{ id: "unit-1", allowed_files: ["src/a.js"], acceptance_criteria: [] }],
  });
  const acceptancePlan = planAdvanceStep(
    { ok: true, action: "transition_then_dispatch" },
    factsFor(noAcceptance),
  );
  assert.equal(acceptancePlan.stop.reason_code, "UNIT_WITHOUT_ACCEPTANCE");
});

test("advance refuses to implement on a protected branch and never names one", () => {
  for (const branch of PROTECTED_BRANCHES) {
    const state = stateFor({ state: "TASK_IMPACT_READY", branch: null });
    const plan = planAdvanceStep(
      { ok: true, action: "transition_then_dispatch" },
      factsFor(state, { branch }),
    );
    assert.equal(plan.execute, undefined, branch);
    assert.equal(plan.stop.reason_code, "NO_EXECUTION_BRANCH");
    assert.equal(plan.stop.boundary, "SELF");
  }
});

test("implementer dispatch is a boundary; only a consumable handoff advances it", () => {
  const state = stateFor({ state: "IMPLEMENTING" });
  const stop = planAdvanceStep(
    { ok: true, action: "dispatch_implementer", agent: "implementer", instruction: "dispatch" },
    factsFor(state),
  );
  assert.equal(stop.execute, undefined);
  assert.equal(stop.stop.boundary, "AGENT");
  assert.equal(stop.stop.dispatch.agent, "implementer");
  assert.deepEqual(stop.stop.dispatch.allowed_files, ["src/one.js", "tests/one.test.js"]);
  assert.deepEqual(stop.stop.dispatch.acceptance_criteria, ["one normalizes input"]);
  assert.equal(stop.stop.handoff_state, "ABSENT");

  // A stale handoff is reported, not consumed.
  const stale = planAdvanceStep(
    { ok: true, action: "consume_implementer_handoff", instruction: "consume" },
    factsFor(state, {
      implementer_handoff: {
        path: ".opencode/handoffs/pr7-implementer.json",
        data: { commit: "old" },
        consumable: false,
        reason: "BASE_NOT_CURRENT_AUTHORIZATION",
      },
    }),
  );
  assert.equal(stale.execute, undefined);
  assert.equal(stale.stop.handoff_state, "BASE_NOT_CURRENT_AUTHORIZATION");

  const consumable = planAdvanceStep(
    { ok: true, action: "consume_implementer_handoff", instruction: "consume" },
    factsFor(state, {
      implementer_handoff: {
        path: ".opencode/handoffs/pr7-implementer.json",
        data: { commit: "head111", status: "DONE" },
        consumable: true,
        reason: null,
      },
    }),
  );
  assert.equal(consumable.execute.step, "consume_implementer_handoff");
  assert.equal(consumable.execute.to, "VERIFYING");
});

test("a missing or outdated review package is rebuilt before the reviewer stop", () => {
  const state = stateFor({ state: "REVIEWING" });
  const build = planAdvanceStep(
    { ok: true, action: "dispatch_reviewer", agent: "reviewer", instruction: "review" },
    factsFor(state),
  );
  assert.equal(build.execute.step, "build_review_package");
  assert.equal(build.execute.scope, "task");

  const stalePackage = planAdvanceStep(
    { ok: true, action: "dispatch_reviewer", agent: "reviewer", instruction: "review" },
    factsFor(state, {
      review_package: { scope: "task", head_commit: "older", unit_or_task: "unit-1" },
    }),
  );
  assert.equal(stalePackage.execute.step, "build_review_package");

  const ready = planAdvanceStep(
    { ok: true, action: "dispatch_reviewer", agent: "reviewer", instruction: "review" },
    factsFor(state, {
      review_package: {
        scope: "task",
        head_commit: "head111",
        unit_or_task: "unit-1",
        path: ".opencode/reviews/pr7-task.md",
        digest_sha256: "d".repeat(64),
        sealed_commands: [{ command: "npm test" }],
      },
    }),
  );
  assert.equal(ready.execute, undefined);
  assert.equal(ready.stop.boundary, "AGENT");
  assert.equal(ready.stop.dispatch.review_scope, "task");
  assert.equal(ready.stop.dispatch.review_package_path, ".opencode/reviews/pr7-task.md");
  assert.deepEqual(ready.stop.dispatch.sealed_commands, ["npm test"]);
});

test("the final scope builds a final package, not a task one", () => {
  const state = stateFor({ state: "FINAL_REVIEWING" });
  const plan = planAdvanceStep(
    { ok: true, action: "dispatch_reviewer", agent: "reviewer", instruction: "review" },
    factsFor(state),
  );
  assert.equal(plan.execute.step, "build_review_package");
  assert.equal(plan.execute.scope, "final");
});

test("review routing is deterministic and conservative", () => {
  const single = stateFor({ state: "REVIEWING", execution_units: [UNITS[0]] });
  const singleFacts = factsFor(single);

  const approvedSingle = reviewRoute({ verdict: "APPROVED", review_scope: "task" }, singleFacts);
  assert.equal(approvedSingle.execute.to, "FINAL_VERIFYING");
  assert.equal(approvedSingle.execute.reuse_final_review, true);
  // The optimistic route must be prechecked, with the mandatory review as fallback.
  assert.equal(approvedSingle.execute.precheck, "FINAL_VERIFYING");
  assert.equal(approvedSingle.execute.fallback.to, "FINAL_REVIEWING");

  const multi = stateFor({ state: "REVIEWING" });
  const nextUnitRoute = reviewRoute(
    { verdict: "APPROVED", review_scope: "task" },
    factsFor(multi),
  );
  assert.equal(nextUnitRoute.execute.to, "TASK_IMPACT_READY");
  assert.equal(nextUnitRoute.execute.next_task, true);
  assert.equal(nextUnitRoute.execute.unit, "unit-2");
  assert.equal(nextUnitRoute.execute.fresh_impact, true);
  assert.deepEqual(nextUnitRoute.execute.targets, ["src/two.js"]);

  const lastUnit = stateFor({
    state: "REVIEWING",
    current_unit: "unit-2",
    task_history: [{ id: "unit-1", verdict: "APPROVED" }],
  });
  const finalReview = reviewRoute(
    { verdict: "APPROVED", review_scope: "task" },
    factsFor(lastUnit),
  );
  assert.equal(finalReview.execute.to, "FINAL_REVIEWING");
  assert.equal(finalReview.execute.reuse_final_review, undefined);

  const changes = reviewRoute(
    { verdict: "REQUEST_CHANGES", review_scope: "task" },
    factsFor(multi),
  );
  assert.equal(changes.execute.to, "TASK_IMPACT_READY");
  assert.equal(changes.execute.reason, "REQUEST_CHANGES");
  assert.equal(changes.execute.fresh_impact, true);
  assert.equal(changes.execute.next_task, undefined);

  const finalApproved = reviewRoute(
    { verdict: "APPROVED", review_scope: "final" },
    factsFor(stateFor({ state: "FINAL_REVIEWING" })),
  );
  assert.equal(finalApproved.execute.to, "FINAL_VERIFYING");

  for (const verdict of ["BLOCKED", "NEEDS_INFO", undefined]) {
    const route = reviewRoute({ verdict, review_scope: "task" }, singleFacts);
    assert.equal(route.execute, undefined, String(verdict));
    assert.equal(route.stop.reason_code, "NON_ADVANCING_VERDICT");
  }
});

test("prepared dispatches carry evidence and never a verdict", () => {
  const state = stateFor({
    state: "IMPLEMENTING",
    impact: { risk: "MEDIUM", direct_dependents: { "src/one.js": ["src/two.js"] }, related_tests: ["tests/one.test.js"] },
  });
  const dispatch = preparedDispatch("implementer", factsFor(state), {
    skill: "nexus-orchestrating",
  });
  assert.equal(dispatch.agent, "implementer");
  assert.equal(dispatch.impact.risk, "MEDIUM");
  assert.equal(
    dispatch.prompt,
    "skills/nexus-orchestrating/implementer-prompt.md",
  );
  for (const forbidden of ["verdict", "status", "approved", "review_handoff", "handoff"]) {
    assert.equal(forbidden in dispatch, false, forbidden);
  }
});

test("unit selection follows recorded approvals, not optimism", () => {
  const state = stateFor({
    current_unit: null,
    task_history: [{ id: "unit-1", verdict: "APPROVED" }],
  });
  assert.equal(currentUnit(state).id, "unit-2");
  assert.equal(nextUnit(state), null);

  const fresh = stateFor({ current_unit: null, task_history: [] });
  assert.equal(currentUnit(fresh).id, "unit-1");
  assert.equal(nextUnit(fresh).id, "unit-2");

  // unit-2 depends on unit-1: it cannot be selected as "next" before approval.
  const blocked = stateFor({
    current_unit: "unit-1",
    execution_units: [UNITS[0], { ...UNITS[1], depends_on: ["unit-3"] }],
  });
  assert.equal(nextUnit(blocked), null);
});
