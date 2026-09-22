/**
 * PR4: adaptive planning depth and uncertainty-triggered plan-advisor.
 *
 * Planning depth and independent planning challenge are separate variables.
 * These tests pin both directions: the saving (a clear task spends no advisor
 * call) and the escalation (any deterministic safety signal still does).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compactEligibility,
  detectPlanningSignals,
  inferPlanningMode,
  normalizePlanAdvisorDecision,
  planAdvisorCallCount,
  planAdvisorDecision,
  shouldInvokePlanAdvisor,
} from "../scripts/lib/planning.js";
import { agentCostModel, estimateAgentCalls } from "../scripts/lib/agent-estimate.js";
import { getAgentCallBudget } from "../scripts/lib/providers.js";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import { canTransition, transition } from "../scripts/lib/state-machine.js";

function planningWorktree(mode) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pr4-planning-"));
  const planDir = path.join(worktree, ".opencode", "plans");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(
    path.join(planDir, "PLAN.md"),
    `# Plan\n- Planning mode: ${mode}\n- Plan commit: 1234567\n\n## Goal\nDeliver the behavior.\n\n## Non-goals\n- No unrelated refactoring.\n\n## Execution Unit Justification\nNumber of units: 1\n\nWhy not fewer:\n- One cohesive behavior owns the outcome.\n\nWhy not more:\n- There is no independent boundary to split.\n\n## Execution Unit breakdown\n### Execution Unit 1: behavior\n- id: unit-1\n- user_outcome: Deliver the behavior\n- independently_shippable: true\n- review_boundary: NONE\n- estimated_lines: 10\n- Allowed files: \`src/app.js\`\n- Evidence:\n  - \`src/app.js:1\` current behavior\n- Acceptance criteria:\n  - [ ] behavior works.\n- Verification gates:\n  1. npm test\n- STOP conditions:\n  - STOP if \`src/app.js\` no longer exists.\n`,
  );
  return worktree;
}

const passingPlanCheck = { ok: true, plan_check: "PASS", errors: [] };

function validAdvisorHandoff() {
  return {
    schema_version: "1.0",
    agent: "plan-advisor",
    calls: 1,
    read_only: true,
    wrote_production_code: false,
    permission_profile: "read-only-bash-allowlist",
    plan_verdict: "KEEP",
    simpler_approach_available: false,
    units: [],
    missing_dependencies: [],
    missing_edge_cases: [],
    risk_misses: [],
    recommended_unit_count: 1,
    model: "openai/gpt-5-mini",
  };
}

// ---------------------------------------------------------------------------
// Case 1: a cohesive multi-file low-risk feature is compact.
// ---------------------------------------------------------------------------
test("case 1: a 3-file cohesive LOW-risk feature is compact and spends no advisor call", () => {
  const evidence = {
    files_changed: ["src/foo.js", "src/foo.test.js", "src/types.js"],
    estimated_lines: 80,
    risk: "LOW",
    cohesive_unit: true,
    known_pattern: true,
  };
  assert.deepEqual(detectPlanningSignals(evidence), []);
  const eligibility = compactEligibility(evidence);
  assert.equal(eligibility.eligible, true);
  assert.equal(inferPlanningMode(evidence), "compact");

  const decision = planAdvisorDecision(evidence);
  assert.equal(decision.required, false);
  assert.equal(decision.planning_mode, "compact");
  assert.ok(decision.reason_codes.includes("NO_HARD_TRIGGER"));
  assert.equal(planAdvisorCallCount("compact", { decision }), 0);
  assert.equal(shouldInvokePlanAdvisor(evidence), false);
});

test("the old one-file / twenty-line rule no longer decides compact on its own", () => {
  // Previously: files <= 1 && lines <= 20 was the only compact path.
  const cohesive = {
    files_changed: 4,
    estimated_lines: 140,
    risk: "MEDIUM",
    cohesive_unit: true,
    known_pattern: true,
  };
  assert.equal(inferPlanningMode(cohesive), "compact");

  // Size is still a signal: an oversized review surface is not compact.
  assert.equal(
    inferPlanningMode({ ...cohesive, files_changed: 6 }),
    "standard",
  );
  assert.equal(
    inferPlanningMode({ ...cohesive, estimated_lines: 151 }),
    "standard",
  );

  // Absence of signals is not enough; cohesion must be declared or measured.
  assert.equal(inferPlanningMode({ files_changed: 3, estimated_lines: 120 }), "standard");
});

// ---------------------------------------------------------------------------
// Case 2: a tiny public-contract change is never compact.
// ---------------------------------------------------------------------------
test("case 2: a 1-file public API change is not compact and requires the advisor", () => {
  const evidence = {
    files_changed: 1,
    estimated_lines: 15,
    change_class: "public-api-change",
    cohesive_unit: true,
    known_pattern: true,
    risk: "LOW",
  };
  assert.deepEqual(detectPlanningSignals(evidence), ["PUBLIC_CONTRACT"]);
  assert.equal(compactEligibility(evidence).eligible, false);
  assert.notEqual(inferPlanningMode(evidence), "compact");

  const decision = planAdvisorDecision(evidence);
  assert.equal(decision.required, true);
  assert.equal(decision.precedence, "hard_trigger");
  assert.ok(decision.reason_codes.includes("PUBLIC_CONTRACT"));
});

test("a one-line authentication change is never compact even though it is tiny", () => {
  const evidence = {
    files_changed: 1,
    estimated_lines: 15,
    change_class: "authentication-behavior-change",
    cohesive_unit: true,
    known_pattern: true,
    risk: "LOW",
  };
  assert.deepEqual(detectPlanningSignals(evidence), ["SECURITY_BOUNDARY"]);
  assert.equal(inferPlanningMode(evidence), "deep");
  assert.equal(planAdvisorDecision(evidence).required, true);
});

// ---------------------------------------------------------------------------
// Case 3 + 4: standard depth decoupled from the challenge decision.
// ---------------------------------------------------------------------------
test("case 3: a clear standard single-unit known-pattern change needs no advisor", () => {
  const decision = planAdvisorDecision({
    planning_mode: "standard",
    unit_count: 1,
    cohesive_unit: true,
    known_pattern: true,
    risk: "LOW",
    files_changed: 4,
    estimated_lines: 120,
  });
  assert.equal(decision.planning_mode, "standard");
  assert.equal(decision.required, false);
  assert.equal(decision.precedence, "cohesive_task");
  assert.deepEqual(decision.reason_codes, [
    "SINGLE_COHESIVE_UNIT",
    "KNOWN_IMPLEMENTATION_PATTERN",
    "NO_ARCHITECTURAL_CHOICE",
    "IMPACT_NOT_HIGH",
    "NO_HARD_TRIGGER",
    "NO_EXPLICIT_UNCERTAINTY",
  ]);
});

test("case 4: a standard task with two plausible architectures requires the advisor", () => {
  const evidence = {
    planning_mode: "standard",
    unit_count: 1,
    cohesive_unit: true,
    known_pattern: true,
    risk: "LOW",
    architectural_choice: true,
  };
  const decision = planAdvisorDecision(evidence);
  assert.equal(decision.planning_mode, "standard");
  assert.equal(decision.required, true);
  assert.equal(decision.precedence, "hard_trigger");
  assert.ok(decision.reason_codes.includes("ARCHITECTURAL_CHOICE"));

  // Architectural choice raises the challenge without forcing deep depth.
  assert.equal(inferPlanningMode({ ...evidence, planning_mode: undefined }), "standard");
});

test("explicit planning uncertainty requires the advisor without any hard trigger", () => {
  const decision = planAdvisorDecision({
    planning_mode: "standard",
    unit_count: 1,
    cohesive_unit: true,
    known_pattern: true,
    risk: "LOW",
    decomposition_uncertain: true,
  });
  assert.equal(decision.required, true);
  assert.equal(decision.precedence, "explicit_uncertainty");
  assert.deepEqual(decision.reason_codes, ["DECOMPOSITION_UNCERTAIN"]);

  const openQuestion = planAdvisorDecision({
    planning_mode: "standard",
    unit_count: 1,
    cohesive_unit: true,
    known_pattern: true,
    risk: "LOW",
    open_questions: ["which store owns the cursor?"],
  });
  assert.equal(openQuestion.required, true);
  assert.ok(openQuestion.reason_codes.includes("UNRESOLVED_DECISION"));
});

// ---------------------------------------------------------------------------
// Cases 5-8: risk and safety escalation.
// ---------------------------------------------------------------------------
test("case 5: HIGH impact requires the advisor", () => {
  for (const risk of ["HIGH", "CRITICAL"]) {
    const evidence = { risk, unit_count: 1, cohesive_unit: true, known_pattern: true };
    assert.deepEqual(detectPlanningSignals(evidence), ["HIGH_IMPACT"]);
    assert.equal(inferPlanningMode(evidence), "deep");
    const decision = planAdvisorDecision(evidence);
    assert.equal(decision.required, true);
    assert.ok(decision.reason_codes.includes("HIGH_IMPACT"));
  }
});

test("case 6: UNKNOWN impact requires the advisor, while unmeasured impact does not escalate", () => {
  const unknown = { risk: "UNKNOWN", unit_count: 1, cohesive_unit: true, known_pattern: true };
  assert.deepEqual(detectPlanningSignals(unknown), ["UNKNOWN_IMPACT"]);
  assert.equal(inferPlanningMode(unknown), "deep");
  assert.equal(planAdvisorDecision(unknown).required, true);

  // Impact normally runs after planning, so an absent measurement is not an
  // UNKNOWN measurement. It is disclosed instead of silently escalated.
  const unmeasured = planAdvisorDecision({
    planning_mode: "standard",
    unit_count: 1,
    cohesive_unit: true,
    known_pattern: true,
  });
  assert.equal(unmeasured.required, false);
  assert.ok(unmeasured.reason_codes.includes("IMPACT_UNMEASURED_AT_PLANNING"));
});

test("case 7: a migration is deep and requires the advisor", () => {
  const evidence = { change_class: "database-migration", unit_count: 1, cohesive_unit: true, known_pattern: true };
  assert.ok(detectPlanningSignals(evidence).includes("MIGRATION"));
  assert.equal(inferPlanningMode(evidence), "deep");
  const decision = planAdvisorDecision(evidence);
  assert.equal(decision.required, true);
  assert.ok(decision.reason_codes.includes("MIGRATION"));
  assert.ok(decision.reason_codes.includes("DEEP_PLANNING_DEPTH"));
});

test("case 8: a security boundary change is deep and requires the advisor", () => {
  for (const evidence of [
    { change_class: "auth-boundary-change" },
    { hard_triggers: ["credential rotation"] },
    { security_boundary: true },
  ]) {
    const full = { ...evidence, unit_count: 1, cohesive_unit: true, known_pattern: true };
    assert.ok(
      detectPlanningSignals(full).includes("SECURITY_BOUNDARY"),
      JSON.stringify(evidence),
    );
    assert.equal(inferPlanningMode(full), "deep");
    assert.equal(planAdvisorDecision(full).required, true);
  }
});

test("every declared semantic signal disqualifies compact planning", () => {
  const base = {
    files_changed: 2,
    estimated_lines: 40,
    risk: "LOW",
    unit_count: 1,
    cohesive_unit: true,
    known_pattern: true,
  };
  assert.equal(compactEligibility(base).eligible, true);
  for (const signal of [
    "PUBLIC_CONTRACT",
    "SECURITY_BOUNDARY",
    "MIGRATION",
    "DESTRUCTIVE_CHANGE",
    "ARCHITECTURAL_CHOICE",
    "MULTI_SUBSYSTEM",
    "UNRESOLVED_DECISION",
    "HIGH_IMPACT",
    "UNKNOWN_IMPACT",
  ]) {
    const eligibility = compactEligibility({ ...base, semantic_signals: [signal] });
    assert.equal(eligibility.eligible, false, signal);
    assert.deepEqual(eligibility.blocking_signals, [signal]);
    assert.equal(
      planAdvisorDecision({ ...base, semantic_signals: [signal] }).required,
      true,
      signal,
    );
  }
});

// ---------------------------------------------------------------------------
// Cases 9-10: state-machine enforcement.
// ---------------------------------------------------------------------------
test("case 9: a required advisor missing at PLANNED fails closed", (t) => {
  const worktree = planningWorktree("deep");
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const state = { ...createEmptyRunState("pr4-run"), state: "BRAINSTORMING" };
  const result = canTransition(state, "PLANNED", {
    plan_exists: true,
    plan_check: passingPlanCheck,
    worktree,
    planning_mode: "deep",
    change_class: "database-migration",
  });
  assert.equal(result.ok, false);
  const joined = result.errors.join(" ");
  assert.match(joined, /plan-advisor is required before PLANNED/);
  assert.match(joined, /MIGRATION/);
});

test("case 10: PLANNED does not demand an advisor artifact when none is required", (t) => {
  const worktree = planningWorktree("standard");
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const state = { ...createEmptyRunState("pr4-run"), state: "BRAINSTORMING" };
  const ctx = {
    plan_exists: true,
    plan_check: passingPlanCheck,
    worktree,
    planning_mode: "standard",
    unit_count: 1,
    cohesive_unit: true,
    known_pattern: true,
    risk: "LOW",
  };
  const result = canTransition(state, "PLANNED", ctx);
  assert.equal(result.ok, true, result.errors.join("; "));

  const next = transition(state, "PLANNED", ctx);
  assert.equal(next.ok, true, next.errors?.join("; "));
  assert.equal(next.state.planning_mode, "standard");
  assert.equal(next.state.plan_advisor, null);
  assert.equal(next.state.plan_advisor_calls, 0);
  assert.equal(next.state.plan_advisor_decision.required, false);
  assert.ok(
    next.state.plan_advisor_decision.reason_codes.includes("SINGLE_COHESIVE_UNIT"),
  );
  assert.equal(next.state.plan_advisor_decision.version, "nexus-plan-advisor-decision/1");
});

test("a required advisor decision is satisfied by a schema-complete handoff", (t) => {
  const worktree = planningWorktree("deep");
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const state = { ...createEmptyRunState("pr4-run"), state: "BRAINSTORMING" };
  const ctx = {
    plan_exists: true,
    plan_check: passingPlanCheck,
    worktree,
    planning_mode: "deep",
    change_class: "database-migration",
    orchestrator_model: "anthropic/claude-sonnet-4",
    plan_advisor: validAdvisorHandoff(),
  };
  const result = canTransition(state, "PLANNED", ctx);
  assert.equal(result.ok, true, result.errors.join("; "));
  const next = transition(state, "PLANNED", ctx);
  assert.equal(next.state.plan_advisor_calls, 1);
  assert.equal(next.state.plan_advisor_decision.required, true);
  assert.ok(next.state.plan_advisor_decision.reason_codes.includes("MIGRATION"));
});

test("an explicit compact claim cannot bypass a deterministic safety signal", (t) => {
  const worktree = planningWorktree("compact");
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const state = { ...createEmptyRunState("pr4-run"), state: "BRAINSTORMING" };
  const result = canTransition(state, "PLANNED", {
    plan_exists: true,
    plan_check: passingPlanCheck,
    worktree,
    planning_mode: "compact",
    change_class: "auth-token-refresh",
    cohesive_unit: true,
    known_pattern: true,
    risk: "LOW",
  });
  assert.equal(result.ok, false);
  const joined = result.errors.join(" ");
  assert.match(joined, /compact planning is not admissible/);
  assert.match(joined, /SECURITY_BOUNDARY/);
});

test("a caller cannot declare required:false to clear a hard trigger", (t) => {
  const worktree = planningWorktree("standard");
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const state = { ...createEmptyRunState("pr4-run"), state: "BRAINSTORMING" };
  const result = canTransition(state, "PLANNED", {
    plan_exists: true,
    plan_check: passingPlanCheck,
    worktree,
    planning_mode: "standard",
    change_class: "public-api-rename",
    cohesive_unit: true,
    known_pattern: true,
    risk: "LOW",
    plan_advisor_decision: {
      required: false,
      reason_codes: ["TRUST_ME"],
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /PUBLIC_CONTRACT/);
});

test("a caller may only raise the requirement", (t) => {
  const worktree = planningWorktree("standard");
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const state = { ...createEmptyRunState("pr4-run"), state: "BRAINSTORMING" };
  const ctx = {
    plan_exists: true,
    plan_check: passingPlanCheck,
    worktree,
    planning_mode: "standard",
    unit_count: 1,
    cohesive_unit: true,
    known_pattern: true,
    risk: "LOW",
    plan_advisor_decision: {
      required: true,
      reason_codes: ["ORCHESTRATOR_UNCERTAIN"],
    },
  };
  const result = canTransition(state, "PLANNED", ctx);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /CALLER_DECLARED_UNCERTAINTY/);
});

test("a malformed persisted decision is discarded rather than trusted", () => {
  for (const malformed of [
    null,
    {},
    { required: "false", reason_codes: ["X"] },
    { required: false },
    { required: false, reason_codes: [] },
    [{ required: false, reason_codes: ["X"] }],
  ]) {
    assert.equal(normalizePlanAdvisorDecision(malformed), null, JSON.stringify(malformed));
  }
  // Discarded means the conservative mode-only fallback applies.
  assert.equal(planAdvisorCallCount("standard", { decision: { required: false } }), 1);
  assert.equal(
    planAdvisorCallCount("standard", {
      decision: { required: false, reason_codes: ["SINGLE_COHESIVE_UNIT"] },
    }),
    0,
  );
});

test("a run with no planning evidence keeps the compact default", (t) => {
  const worktree = planningWorktree("compact");
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const state = { ...createEmptyRunState("pr4-run"), state: "BRAINSTORMING" };
  const result = canTransition(state, "PLANNED", {
    plan_exists: true,
    plan_check: passingPlanCheck,
    worktree,
  });
  assert.equal(result.ok, true, result.errors.join("; "));
});

// ---------------------------------------------------------------------------
// Cases 11-12: cost model.
// ---------------------------------------------------------------------------
test("case 11: the estimator uses the persisted decision and saves exactly one call", () => {
  const conservative = estimateAgentCalls({ units: 1, planningMode: "standard" });
  assert.equal(conservative.plan_advisor_calls, 1);

  const decision = planAdvisorDecision({
    planning_mode: "standard",
    unit_count: 1,
    cohesive_unit: true,
    known_pattern: true,
    risk: "LOW",
  });
  const decided = estimateAgentCalls({
    units: 1,
    planningMode: "standard",
    advisorDecision: decision,
  });
  assert.equal(decided.plan_advisor_calls, 0);
  assert.equal(conservative.calls.total - decided.calls.total, 1);
  assert.equal(decided.calls.implementer, 1);
  assert.equal(decided.calls.task_reviewer, 1);
  assert.equal(decided.plan_advisor_decision.required, false);

  // The runtime budget agrees with the estimator.
  assert.equal(
    decided.calls.budget_ceiling,
    getAgentCallBudget({
      units: 1,
      planningMode: "standard",
      planAdvisorDecision: decision,
    }).max_calls,
  );
  const budget = getAgentCallBudget({
    units: 1,
    planningMode: "standard",
    planAdvisorDecision: decision,
  });
  assert.equal(budget.planning_advisor_calls, undefined);
  assert.equal(budget.plan_advisor_decision.required, false);
});

test("case 12: the deep CRITICAL_DISAGREEMENT second advisor call is unchanged", () => {
  assert.equal(planAdvisorCallCount("deep"), 1);
  assert.equal(planAdvisorCallCount("deep", { criticalDisagreement: true }), 2);
  assert.equal(planAdvisorCallCount("standard", { criticalDisagreement: true }), 1);

  const deepDecision = planAdvisorDecision({ planning_mode: "deep" });
  assert.equal(deepDecision.required, true);
  assert.ok(deepDecision.reason_codes.includes("DEEP_PLANNING_DEPTH"));
  assert.equal(
    planAdvisorCallCount("deep", { criticalDisagreement: true, decision: deepDecision }),
    2,
  );
  assert.equal(
    agentCostModel({
      units: 2,
      planningMode: "deep",
      advisorDecision: deepDecision,
      criticalDisagreement: true,
    }).calls.plan_advisor,
    2,
  );
});

test("deep planning keeps its mandatory advisor call even with cohesion evidence", () => {
  const decision = planAdvisorDecision({
    planning_mode: "deep",
    unit_count: 1,
    cohesive_unit: true,
    known_pattern: true,
    risk: "LOW",
  });
  assert.equal(decision.required, true);
  assert.equal(decision.precedence, "hard_trigger");
  assert.equal(planAdvisorCallCount("deep", { decision }), 1);
});
