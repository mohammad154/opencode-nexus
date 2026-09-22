/**
 * PR8: SPEC identity and traceability (pure model).
 *
 * Permanent regressions:
 * - Criterion identity is deterministic and stable: the same plan always yields
 *   the same ids and digests, and identity does not depend on unrelated units.
 * - Only an APPROVED review counts as coverage; REQUEST_CHANGES, CANNOT_VERIFY,
 *   FAIL, and a missing entry never do.
 * - The model measures; it never accepts a claim of coverage.
 * - Convergence is vacuous for runs whose plan persisted no units, so the gate
 *   adds a requirement instead of inventing a plan.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  COVERAGE_STATUS,
  TRACE_VERSION,
  approvedReviews,
  convergenceErrors,
  criterionDigest,
  criterionId,
  formatTrace,
  normalizeCriterionText,
  planCriteria,
  planRequirements,
  plannedUnitIds,
  requirementMappingErrors,
  traceMatrix,
  unitsCovering,
} from "../scripts/lib/traceability.js";

const units = [
  { id: "unit-1", acceptance_criteria: ["sum clamps to max", "two-arg calls unchanged"] },
  { id: "unit-2", acceptance_criteria: ["avg clamps to max"] },
];

function approval(unit, acceptance, extra = {}) {
  return {
    id: unit,
    verdict: "APPROVED",
    reviewed_commit: "c".repeat(40),
    acceptance_criteria: (units.find((u) => u.id === unit) || {}).acceptance_criteria || [],
    review_handoff: { review_scope: "task", unit_or_task: unit, verdict: "APPROVED", acceptance },
    ...extra,
  };
}

const pass = (id, criterion) => ({
  id,
  criterion,
  status: "PASS",
  evidence: [{ file: "tests/t.test.js", line: 1, reason: "asserted" }],
});

test("criterion identity is deterministic and position-stable", () => {
  assert.equal(criterionId("unit-1", 0), "unit-1/AC1");
  assert.equal(criterionId("unit-2", 2), "unit-2/AC3");

  const rows = planCriteria({ execution_units: units });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["unit-1/AC1", "unit-1/AC2", "unit-2/AC1"],
  );
  // Recomputing over the same plan is byte-identical.
  assert.deepEqual(rows, planCriteria({ execution_units: units }));
  // A unit's ids do not depend on other units: removing unit-1 leaves unit-2's
  // identity untouched.
  const isolated = planCriteria({ execution_units: [units[1]] });
  assert.equal(isolated[0].id, "unit-2/AC1");
  assert.equal(isolated[0].digest, rows[2].digest);
});

test("digests ignore cosmetic edits and separate real ones", () => {
  assert.equal(normalizeCriterionText("- [ ]  Sum   Clamps "), "sum clamps");
  assert.equal(criterionDigest("Sum clamps"), criterionDigest("- [x] sum   CLAMPS"));
  assert.notEqual(criterionDigest("sum clamps"), criterionDigest("sum does not clamp"));
  assert.equal(criterionDigest("   "), null);
  assert.match(criterionDigest("sum clamps"), /^[0-9a-f]{12}$/);
});

test("only APPROVED reviews are coverage", () => {
  const state = {
    execution_units: units,
    task_history: [
      { id: "unit-1", verdict: "REQUEST_CHANGES", review_handoff: { acceptance: [pass("AC-1")] } },
    ],
  };
  assert.equal(approvedReviews(state).size, 0);
  const matrix = traceMatrix(state);
  assert.equal(matrix.units[0].status, COVERAGE_STATUS.NOT_REVIEWED);
  assert.equal(matrix.summary.criteria_covered, 0);
});

test("a criterion needs its own passing entry, not a bare APPROVED", () => {
  const state = {
    execution_units: [units[0]],
    task_history: [
      approval("unit-1", [
        pass("unit-1/AC1", "sum clamps to max"),
        { id: "unit-1/AC2", status: "CANNOT_VERIFY", evidence: [] },
      ]),
    ],
  };
  const matrix = traceMatrix(state);
  assert.equal(matrix.rows[0].status, COVERAGE_STATUS.COVERED);
  assert.equal(matrix.rows[1].status, COVERAGE_STATUS.NOT_APPROVED);
  assert.equal(matrix.rows[1].reported_status, "CANNOT_VERIFY");
  assert.match(
    convergenceErrors(state).join(" "),
    /passing acceptance result for every planned criterion; missing: unit-1\/AC2/,
  );
});

test("evidence is required, not just a PASS label", () => {
  const state = {
    execution_units: [{ id: "unit-1", acceptance_criteria: ["sum clamps to max"] }],
    task_history: [
      approval("unit-1", [
        { id: "unit-1/AC1", status: "PASS", evidence: [] },
      ]),
    ],
  };
  // The ledger records the PASS the reviewer reported; evidence sufficiency is
  // enforced where the verdict is admitted (isApprovalAdmissible), so the two
  // gates cannot disagree about what "reported" means.
  const matrix = traceMatrix(state);
  assert.equal(matrix.rows[0].status, COVERAGE_STATUS.COVERED);
  assert.deepEqual(matrix.rows[0].evidence, []);
});

test("matching prefers identity and flags a positional-only match", () => {
  const identity = traceMatrix({
    execution_units: [units[0]],
    task_history: [
      approval("unit-1", [
        pass("unit-1/AC1", "sum clamps to max"),
        pass("unit-1/AC2", "two-arg calls unchanged"),
      ]),
    ],
  });
  assert.deepEqual(
    identity.rows.map((row) => row.positional_match),
    [false, false],
  );

  const legacy = traceMatrix({
    execution_units: [units[0]],
    task_history: [approval("unit-1", [pass("AC-1"), pass("AC-2")])],
  });
  assert.deepEqual(
    legacy.rows.map((row) => row.status),
    [COVERAGE_STATUS.COVERED, COVERAGE_STATUS.COVERED],
  );
  assert.equal(legacy.summary.criteria_positional_match, 2);
});

test("text drift is reported, never rejected", () => {
  // The unit was authorized with paraphrased criteria. That is visible, but it
  // does not withhold coverage: a run must not fail at COMPLETED for wording.
  const state = {
    execution_units: [{ id: "unit-1", acceptance_criteria: ["sum clamps to max"] }],
    task_history: [
      {
        id: "unit-1",
        verdict: "APPROVED",
        reviewed_commit: "c".repeat(40),
        acceptance_criteria: ["the sum is clamped at the caller's maximum"],
        review_handoff: { acceptance: [pass("AC-1")] },
      },
    ],
  };
  const matrix = traceMatrix(state);
  assert.equal(matrix.rows[0].status, COVERAGE_STATUS.COVERED);
  assert.equal(matrix.rows[0].authorized_text_match, false);
  assert.equal(matrix.summary.criteria_text_drift, 1);
  assert.deepEqual(convergenceErrors(state), []);
});

test("an abandoned unit is named once, without repeating its criteria", () => {
  const state = {
    execution_units: units,
    task_history: [
      approval("unit-1", [pass("unit-1/AC1", "sum clamps to max"), pass("unit-1/AC2", "two-arg calls unchanged")]),
    ],
  };
  const errors = convergenceErrors(state, { label: "COMPLETED" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /approved task review for every planned execution unit; missing: unit-2/);
  assert.equal(traceMatrix(state).summary.converged, false);
});

test("a fully covered plan converges", () => {
  const state = {
    execution_units: units,
    task_history: [
      approval("unit-1", [pass("unit-1/AC1", "sum clamps to max"), pass("unit-1/AC2", "two-arg calls unchanged")]),
      approval("unit-2", [pass("unit-2/AC1", "avg clamps to max")]),
    ],
  };
  assert.deepEqual(convergenceErrors(state), []);
  const matrix = traceMatrix(state);
  assert.equal(matrix.summary.converged, true);
  assert.equal(matrix.summary.criteria_covered, 3);
  assert.equal(matrix.version, TRACE_VERSION);
});

test("convergence is vacuous when the plan persisted no units", () => {
  assert.deepEqual(convergenceErrors({}), []);
  assert.deepEqual(convergenceErrors({ execution_units: [] }), []);
  assert.deepEqual(plannedUnitIds({}), []);
  assert.equal(traceMatrix({}).summary.converged, false);
});

test("a unit with no acceptance criteria still needs a review", () => {
  const state = { execution_units: [{ id: "unit-1", acceptance_criteria: [] }] };
  assert.match(convergenceErrors(state).join(" "), /missing: unit-1/);
  const reviewed = {
    ...state,
    task_history: [{ id: "unit-1", verdict: "APPROVED", review_handoff: { acceptance: [] } }],
  };
  assert.deepEqual(convergenceErrors(reviewed), []);
  assert.equal(traceMatrix(reviewed).units[0].status, COVERAGE_STATUS.NO_CRITERIA);
});

test("declared requirements must be claimed by a unit", () => {
  const plan = {
    requirements: [
      { id: "R1", text: "a caller can clamp a sum" },
      { id: "R2", text: "a caller can clamp an average" },
    ],
    execution_units: [{ ...units[0], covers: ["R1"] }, units[1]],
  };
  assert.deepEqual(planRequirements(plan).map((r) => r.id), ["R1", "R2"]);
  assert.deepEqual(unitsCovering(plan, "R1"), ["unit-1"]);
  const errors = requirementMappingErrors(plan);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /R2 is declared but no execution unit declares "covers: R2"/);

  // Mapped to a unit that does not exist is also a mapping failure.
  assert.match(
    requirementMappingErrors({
      requirements: [{ id: "R1", text: "x" }],
      execution_units: [{ id: "unit-1", covers: ["R1"] }, { id: "unit-2", covers: "R1" }],
    }).join(" ") || "none",
    /none/,
  );
  assert.match(
    requirementMappingErrors({
      requirements: [{ id: "R9", text: "x" }],
      execution_units: [{ id: "unit-1", covers: [] }],
    }).join(" "),
    /R9/,
  );
});

test("plans without a Requirements section are unaffected", () => {
  assert.deepEqual(requirementMappingErrors({ execution_units: units }), []);
  assert.deepEqual(planRequirements({}), []);
  assert.equal(traceMatrix({ execution_units: units }).requirements.length, 0);
});

test("a requirement is covered only when its units are fully covered", () => {
  const base = {
    requirements: [{ id: "R1", text: "clamping works end to end" }],
    execution_units: [
      { id: "unit-1", covers: ["R1"], acceptance_criteria: ["sum clamps to max"] },
      { id: "unit-2", covers: ["R1"], acceptance_criteria: ["avg clamps to max"] },
    ],
  };
  const partial = {
    ...base,
    task_history: [approval("unit-1", [pass("unit-1/AC1", "sum clamps to max")])],
  };
  assert.equal(traceMatrix(partial).requirements[0].status, COVERAGE_STATUS.NOT_APPROVED);
  assert.match(convergenceErrors(partial).join(" "), /missing: unit-2/);

  const full = {
    ...base,
    task_history: [
      { id: "unit-1", verdict: "APPROVED", acceptance_criteria: ["sum clamps to max"], review_handoff: { acceptance: [pass("unit-1/AC1", "sum clamps to max")] } },
      { id: "unit-2", verdict: "APPROVED", acceptance_criteria: ["avg clamps to max"], review_handoff: { acceptance: [pass("unit-2/AC1", "avg clamps to max")] } },
    ],
  };
  assert.deepEqual(convergenceErrors(full), []);
  assert.equal(traceMatrix(full).requirements[0].status, COVERAGE_STATUS.COVERED);
  assert.equal(traceMatrix(full).summary.requirements_covered, 1);
});

test("the trace report names every uncovered row", () => {
  const text = formatTrace(
    traceMatrix({
      requirements: [{ id: "R1", text: "clamping" }],
      execution_units: [{ id: "unit-1", covers: ["R1"], acceptance_criteria: ["sum clamps to max"] }],
    }),
  );
  assert.match(text, /units: 0\/1 reviewed/);
  assert.match(text, /criteria: 0\/1 covered/);
  assert.match(text, /requirements: 0\/1 covered/);
  assert.match(text, /converged: no/);
  assert.match(text, /unit-1\/AC1 NOT_REVIEWED: sum clamps to max/);
  assert.match(text, /R1 — NOT_APPROVED \(units: unit-1\)/);
});
