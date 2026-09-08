import test from "node:test";
import assert from "node:assert/strict";
import { checkPlan, normalizePlan, parsePlanMarkdown } from "../scripts/lib/plan-check.js";

const VALID_PLAN = `# Plan: cohesive units
- Planning mode: standard

## Execution Unit Justification
Number of units: 2

Why not fewer:
- The API and worker have separate implementation and acceptance boundaries.

Why not more:
- Tests and setup remain with the behavior they support.

## Execution Unit breakdown
### Execution Unit 1: API response
- id: unit-1
- Depends on: none
- Allowed files: \`src/api.js\`
- Acceptance criteria:
  - [ ] API returns the new response.
- Verification gates:
  1. npm test -- api

### Execution Unit 2: Worker event
- id: unit-2
- Depends on: unit-1
- Allowed files: \`src/worker.js\`
- Acceptance criteria:
  - [ ] Worker handles the new event.
- Verification gates:
  1. npm test -- worker
`;

test("plan-check parses cohesive execution units and a valid dependency DAG", () => {
  const parsed = parsePlanMarkdown(VALID_PLAN);
  assert.equal(parsed.execution_units.length, 2);
  assert.deepEqual(parsed.execution_units[1].depends_on, ["unit-1"]);
  assert.deepEqual(parsed.execution_units[0].allowed_files, ["src/api.js"]);

  const result = checkPlan(VALID_PLAN, { maxConcurrency: 2 });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.plan_check, "PASS");
  assert.deepEqual(result.dag.waves, [["unit-1"], ["unit-2"]]);
  assert.equal(result.estimate.plan_advisor_calls, 1);
  assert.equal(result.merge_candidates.length, 0);
});

test("plan-check reports missing ownership, cycles, and missing unit justification", () => {
  const result = checkPlan({
    planning_mode: "compact",
    execution_units: [
      {
        id: "a",
        depends_on: ["b"],
        allowed_files: ["src/a.js"],
        acceptance_criteria: [],
        verification_gates: [],
      },
      {
        id: "b",
        depends_on: ["a"],
        allowed_files: ["src/b.js"],
        acceptance_criteria: ["b works"],
        verification_gates: ["npm test"],
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "MISSING_ACCEPTANCE"));
  assert.ok(result.errors.some((error) => error.code === "MISSING_VERIFICATION"));
  assert.ok(result.errors.some((error) => error.code === "DEPENDENCY_CYCLE"));
  assert.ok(
    result.errors.some((error) => error.code === "MISSING_UNIT_JUSTIFICATION"),
  );
});

test("plan-check warns on duplicate scope and test-only units, with strict mode available", () => {
  const plan = normalizePlan({
    justification: {
      number_of_units: 2,
      why_not_fewer: "Separate public boundary.",
      why_not_more: "Tests stay with behavior.",
    },
    execution_units: [
      {
        id: "behavior",
        title: "API behavior",
        allowed_files: ["src/api.js"],
        acceptance_criteria: ["works"],
        verification_gates: ["npm test"],
      },
      {
        id: "tests",
        title: "API tests",
        depends_on: ["behavior"],
        allowed_files: ["tests/api.test.js"],
        acceptance_criteria: ["regression covered"],
        verification_gates: ["npm test -- api"],
      },
    ],
  });
  const result = checkPlan(plan);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.code === "TEST_ONLY_UNIT"));
  const strict = checkPlan(plan, { strict: true });
  assert.equal(strict.ok, false);
});
