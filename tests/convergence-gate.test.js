/**
 * PR8: the convergence gate and the unit identity binding, at the state machine.
 *
 * Permanent regressions:
 * - A planned execution unit cannot be silently abandoned: a run that reviewed
 *   only some of its units cannot enter the final review or COMPLETED.
 * - Work cannot be authorized under a unit the plan never declared.
 * - The single-unit reuse route records its approval, so the ledger is complete
 *   whichever route the run takes.
 * - A fully covered plan still passes: the gate adds no false rejection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { canTransition, transition } from "../scripts/lib/state-machine.js";

const UNITS = [
  { id: "unit-1", acceptance_criteria: ["sum clamps to max"], allowed_files: ["src/sum.js"] },
  { id: "unit-2", acceptance_criteria: ["avg clamps to max"], allowed_files: ["src/avg.js"] },
];

const HEAD = "a".repeat(40);

function reviewHandoff(unit, scope = "task") {
  return {
    schema_version: "1.2",
    run_id: "conv",
    unit_or_task: unit,
    agent: "reviewer",
    base_commit: "b".repeat(40),
    created_at: new Date().toISOString(),
    verdict: "APPROVED",
    review_scope: scope,
    reviewed_commit: HEAD,
    files_reviewed: ["src/sum.js"],
    impact: { pass: true, risk: "LOW" },
    acceptance: [
      {
        id: `${unit}/AC1`,
        criterion: unit === "unit-1" ? "sum clamps to max" : "avg clamps to max",
        status: "PASS",
        evidence: [{ file: "src/sum.js", line: 3, reason: "clamped" }],
      },
    ],
    checks: [
      { category: "correctness", status: "PASS", evidence: "src/sum.js:3" },
      { category: "test_quality", status: "PASS", evidence: "tests/sum.test.js:9" },
      { category: "impact", status: "PASS", evidence: "only the test calls it" },
    ],
    findings: [],
  };
}

function historyEntry(unit) {
  return {
    id: unit,
    verdict: "APPROVED",
    reviewed_commit: HEAD,
    acceptance_criteria: UNITS.find((u) => u.id === unit).acceptance_criteria,
    review_handoff: reviewHandoff(unit),
  };
}

function reviewingState(overrides = {}) {
  return {
    run_id: "conv",
    state: "REVIEWING",
    execution_units: UNITS,
    units: UNITS,
    tasks: UNITS,
    task_count: 2,
    current_unit: "unit-2",
    acceptance_criteria: ["avg clamps to max"],
    branch: "feat/conv",
    head_commit: HEAD,
    verification_status: "PASSED",
    ...overrides,
  };
}

test("a run that reviewed only one of two planned units cannot enter the final review", () => {
  const state = reviewingState({ current_unit: "unit-1", task_history: [] });
  const result = canTransition(state, "FINAL_REVIEWING", {
    review_handoff: reviewHandoff("unit-1"),
  });
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join(" | "),
    /FINAL_REVIEWING requires an approved task review for every planned execution unit; missing: unit-2/,
  );
});

test("the approval submitted in the transition counts, so the last unit can proceed", () => {
  // unit-1 recorded, unit-2 approved right now: the gate must see both.
  const state = reviewingState({
    current_unit: "unit-2",
    task_history: [historyEntry("unit-1")],
  });
  const result = canTransition(state, "FINAL_REVIEWING", {
    review_handoff: reviewHandoff("unit-2"),
  });
  const convergence = result.errors.filter((e) => /planned execution unit|planned criterion/.test(e));
  assert.deepEqual(convergence, []);
});

test("COMPLETED refuses a run whose ledger is incomplete", () => {
  const state = {
    ...reviewingState(),
    state: "FINAL_VERIFYING",
    task_history: [historyEntry("unit-1")],
  };
  const result = canTransition(state, "COMPLETED", {});
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" | "), /COMPLETED requires an approved task review .*missing: unit-2/);
});

test("COMPLETED refuses a unit approved without a passing result for one criterion", () => {
  const partial = historyEntry("unit-2");
  partial.review_handoff = {
    ...partial.review_handoff,
    acceptance: [
      { id: "unit-2/AC1", status: "CANNOT_VERIFY", evidence: [] },
    ],
  };
  const state = {
    ...reviewingState(),
    state: "FINAL_VERIFYING",
    task_history: [historyEntry("unit-1"), partial],
  };
  const result = canTransition(state, "COMPLETED", {});
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join(" | "),
    /passing acceptance result for every planned criterion; missing: unit-2\/AC1/,
  );
});

test("the convergence gate is silent for a fully covered plan", () => {
  const state = {
    ...reviewingState(),
    state: "FINAL_VERIFYING",
    task_history: [historyEntry("unit-1"), historyEntry("unit-2")],
  };
  const result = canTransition(state, "COMPLETED", {});
  const convergence = result.errors.filter((e) =>
    /planned execution unit|planned criterion|declared requirement/.test(e),
  );
  assert.deepEqual(convergence, []);
});

test("a run with no persisted plan units is unaffected", () => {
  const state = { run_id: "legacy", state: "FINAL_VERIFYING", verification_status: "PASSED" };
  const result = canTransition(state, "COMPLETED", {});
  const convergence = result.errors.filter((e) =>
    /planned execution unit|planned criterion|declared requirement/.test(e),
  );
  assert.deepEqual(convergence, []);
});

test("IMPLEMENTING refuses a unit the plan never declared", () => {
  const state = {
    run_id: "conv",
    state: "TASK_IMPACT_READY",
    execution_units: UNITS,
    units: UNITS,
    tasks: UNITS,
  };
  const ctx = {
    branch: "feat/conv",
    current_unit: "unit-9",
    allowed_files: ["src/sum.js"],
    acceptance_criteria: ["sum clamps to max"],
  };
  const result = canTransition(state, "IMPLEMENTING", ctx);
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join(" | "),
    /IMPLEMENTING unit unit-9 is not a planned execution unit \(unit-1, unit-2\)/,
  );

  const missing = canTransition(state, "IMPLEMENTING", { ...ctx, current_unit: undefined });
  assert.match(
    missing.errors.join(" | "),
    /IMPLEMENTING requires current_unit naming a planned execution unit/,
  );

  // The planned id is accepted (other unrelated evidence is still required).
  const named = canTransition(state, "IMPLEMENTING", { ...ctx, current_unit: "unit-1" });
  assert.equal(
    named.errors.some((e) => /planned execution unit/.test(e)),
    false,
    named.errors.join(" | "),
  );
});

test("an evidence-free PASS cannot enter the ledger", () => {
  // The convergence gate trusts the ledger because only admissible approvals
  // reach it. This is that coupling, asserted directly: a PASS without evidence
  // is refused at the transition, so it never becomes coverage.
  const handoff = reviewHandoff("unit-2");
  handoff.acceptance = [
    { id: "unit-2/AC1", criterion: "avg clamps to max", status: "PASS", evidence: [] },
  ];
  const state = reviewingState({ task_history: [historyEntry("unit-1")] });
  const result = canTransition(state, "FINAL_REVIEWING", { review_handoff: handoff });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" | "), /requires non-empty file\/reason evidence/);

  const applied = transition(state, "FINAL_REVIEWING", { review_handoff: handoff });
  assert.equal(applied.ok, false);
  assert.deepEqual(
    (applied.state.task_history || []).map((entry) => entry.id),
    ["unit-1"],
  );
});

test("the ledger and the planned unit set cannot be supplied by the caller", () => {
  // Convergence is only as strong as the state it reads. A caller must not be
  // able to shrink the plan or invent an approval through transition context.
  const state = reviewingState({ current_unit: "unit-1", task_history: [] });
  const forged = canTransition(state, "FINAL_REVIEWING", {
    review_handoff: reviewHandoff("unit-1"),
    // All of these are ignored: the reducer spreads durable state, not ctx.
    execution_units: [UNITS[0]],
    units: [UNITS[0]],
    tasks: [UNITS[0]],
    task_count: 1,
    task_history: [historyEntry("unit-1"), historyEntry("unit-2")],
  });
  assert.equal(forged.ok, false);
  assert.match(forged.errors.join(" | "), /missing: unit-2/);

  const applied = transition(state, "FINAL_REVIEWING", {
    review_handoff: reviewHandoff("unit-1"),
    task_history: [historyEntry("unit-1"), historyEntry("unit-2")],
    execution_units: [UNITS[0]],
  });
  assert.equal(applied.ok, false);
  assert.equal(applied.state.state, "REVIEWING");
  assert.deepEqual(
    applied.state.execution_units.map((unit) => unit.id),
    ["unit-1", "unit-2"],
  );
  assert.deepEqual(applied.state.task_history || [], []);
});

/*
 * The single-unit reuse route is covered end to end in tests/advance-e2e.test.js:
 * that run reaches COMPLETED through the reuse route, which the PR8 convergence
 * gate only permits when the reused task approval was recorded in the ledger.
 * Reproducing it here would require a real worktree, HEAD, and package digest,
 * so the gate would reject a synthetic state before the reducer ever ran.
 */
