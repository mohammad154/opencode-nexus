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
- user_outcome: Return the new API response to callers
- independently_shippable: true
- review_boundary: none
- estimated_lines: 120
- Allowed files: \`src/api.js\`
- Acceptance criteria:
  - [ ] API returns the new response.
- Verification gates:
  1. npm test -- api

### Execution Unit 2: Worker event
- id: unit-2
- Depends on: unit-1
- user_outcome: Process the new worker event
- independently_shippable: true
- review_boundary: none
- estimated_lines: 90
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
  assert.equal(parsed.execution_units[0].user_outcome, "Return the new API response to callers");
  assert.equal(parsed.execution_units[0].independently_shippable, true);
  assert.equal(parsed.execution_units[0].review_boundary, "none");
  assert.equal(parsed.execution_units[0].estimated_lines, 120);
  assert.deepEqual(
    normalizePlan(parsed).execution_units.map(({ user_outcome, independently_shippable, review_boundary, estimated_lines }) => ({ user_outcome, independently_shippable, review_boundary, estimated_lines })),
    parsed.execution_units.map(({ user_outcome, independently_shippable, review_boundary, estimated_lines }) => ({ user_outcome, independently_shippable, review_boundary, estimated_lines })),
  );

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
        user_outcome: "Make A work",
        independently_shippable: false,
        review_boundary: "none",
        estimated_lines: 40,
        allowed_files: ["src/a.js"],
        acceptance_criteria: [],
        verification_gates: [],
      },
      {
        id: "b",
        depends_on: ["a"],
        user_outcome: "Make B work",
        independently_shippable: false,
        review_boundary: "none",
        estimated_lines: 40,
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

test("plan-check warns on test-only units and requires explicit dispositions", () => {
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
        user_outcome: "Serve the API response",
        independently_shippable: false,
        review_boundary: "none",
        estimated_lines: 120,
        allowed_files: ["src/api.js"],
        acceptance_criteria: ["works"],
        verification_gates: ["npm test"],
      },
      {
        id: "tests",
        title: "API tests",
        user_outcome: "Maintain API regression coverage",
        independently_shippable: true,
        review_boundary: "subsystem-boundary",
        estimated_lines: 70,
        depends_on: ["behavior"],
        allowed_files: ["tests/api.test.js"],
        acceptance_criteria: ["regression covered"],
        verification_gates: ["npm test -- api"],
      },
    ],
    warning_dispositions: [
      {
        code: "TEST_ONLY_UNIT",
        units: ["tests"],
        decision: "KEEP_SEPARATE",
        reason_code: "INDEPENDENT_SHIPPING",
        reason: "The test package is maintained and reviewed independently.",
      },
      {
        code: "MERGE_CANDIDATE",
        units: ["behavior", "tests"],
        decision: "KEEP_SEPARATE",
        reason_code: "SUBSYSTEM_BOUNDARY",
        reason: "The behavior and test boundaries are intentionally separate.",
      },
    ],
  });
  const result = checkPlan(plan);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.code === "TEST_ONLY_UNIT"));
  assert.ok(
    result.merge_candidates[0].reasons.includes(
      "tests are only for the dependent unit",
    ),
  );
  const missing = checkPlan({ ...plan, warning_dispositions: [] });
  assert.equal(missing.ok, false);
  assert.ok(
    missing.errors.some(
      (error) => error.code === "MISSING_WARNING_DISPOSITION",
    ),
  );
  const strict = checkPlan(plan, { strict: true });
  assert.equal(strict.ok, false);
});

test("plan-check parses warning dispositions from Markdown", () => {
  const parsed = parsePlanMarkdown(`
## Plan Check Dispositions
- code: MERGE_CANDIDATE
  units: unit-1, unit-2
  decision: KEEP_SEPARATE
  reason_code: PUBLIC_CONTRACT
  reason: independent review boundaries
`);
  assert.deepEqual(parsed.warning_dispositions, [
    {
      code: "MERGE_CANDIDATE",
      units: ["unit-1", "unit-2"],
      file: "",
      decision: "KEEP_SEPARATE",
      reason_code: "PUBLIC_CONTRACT",
      reason: "independent review boundaries",
    },
  ]);
});

function unit(overrides = {}) {
  return {
    id: "unit",
    title: "A distinct implementation step",
    user_outcome: "Complete the user visible workflow",
    independently_shippable: false,
    review_boundary: "none",
    estimated_lines: 80,
    allowed_files: ["src/one.js"],
    acceptance_criteria: ["the behavior works"],
    verification_gates: ["npm test"],
    ...overrides,
  };
}

function plan(execution_units, warning_dispositions = []) {
  return {
    justification: {
      number_of_units: execution_units.length,
      why_not_fewer: "Each retained unit is cohesive and reviewable.",
      why_not_more: "Internal implementation steps stay together.",
    },
    execution_units,
    warning_dispositions,
  };
}

function gapChain() {
  const outcome = "Make the pipeline process real Binance archives with close-time anomalies and genuine gaps.";
  return [
    unit({
      id: "timestamps",
      title: "Repair archive timestamp anomalies",
      user_outcome: outcome,
      estimated_lines: 90,
      allowed_files: ["src/archive/close-time.js"],
    }),
    unit({
      id: "features",
      title: "Teach feature windows to tolerate gaps",
      user_outcome: "  MAKE THE PIPELINE PROCESS REAL BINANCE ARCHIVES WITH CLOSE TIME ANOMALIES AND GENUINE GAPS  ",
      estimated_lines: 95,
      depends_on: ["timestamps"],
      allowed_files: ["src/features/gaps.js"],
    }),
    unit({
      id: "finalization",
      title: "Preserve gap evidence in downstream outputs",
      user_outcome: outcome.toUpperCase(),
      estimated_lines: 100,
      depends_on: ["features"],
      allowed_files: ["src/pipeline/finalize.js"],
    }),
  ];
}

test("same-outcome dependency chains produce blocking strong merge candidates", () => {
  const execution_units = gapChain();
  const result = checkPlan(plan(execution_units), { requireWarningDispositions: false });
  const strong = result.warnings.filter(
    (warning) => warning.code === "STRONG_MERGE_CANDIDATE",
  );

  assert.deepEqual(strong.map((warning) => warning.units), [
    ["timestamps", "features"],
    ["features", "finalization"],
  ]);
  assert.equal(result.merge_candidates.length, 2);
  assert.equal(result.errors.some((error) => /UNIT_METADATA/.test(error.code)), false);
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.filter((error) => error.code === "STRONG_MERGE_REQUIRED").length,
    2,
  );

  const keepSeparate = strong.map((warning) => ({
    code: warning.code,
    units: warning.units,
    decision: "KEEP_SEPARATE",
    reason_code: "SUBSYSTEM_BOUNDARY",
    reason: "These implementation pieces are reviewed independently.",
  }));
  const blockedSplit = checkPlan(plan(execution_units, keepSeparate));
  assert.equal(blockedSplit.ok, false);
  assert.equal(
    blockedSplit.errors.filter(
      (error) => error.code === "STRONG_MERGE_CANDIDATE_CANNOT_KEEP_SEPARATE",
    ).length,
    2,
  );

  const falselyMerged = checkPlan(
    plan(
      execution_units,
      strong.map((warning) => ({
        code: warning.code,
        units: warning.units,
        decision: "MERGED",
        reason: "The units were merged.",
      })),
    ),
  );
  assert.equal(falselyMerged.ok, false);
  assert.equal(
    falselyMerged.errors.filter(
      (error) => error.code === "STRONG_MERGE_REQUIRED",
    ).length,
    2,
  );

  const merged = unit({
    id: "gap-tolerant-pipeline",
    title: "Make real Binance archives gap tolerant end to end",
    user_outcome: execution_units[0].user_outcome,
    independently_shippable: true,
    review_boundary: "none",
    estimated_lines: 285,
    allowed_files: execution_units.flatMap((item) => item.allowed_files),
  });
  const rerun = checkPlan(plan([merged]));
  assert.equal(rerun.ok, true, JSON.stringify(rerun.errors));
  assert.equal(rerun.warnings.some((warning) => warning.code === "STRONG_MERGE_CANDIDATE"), false);
});

test("strong merge candidates use inclusive file and line thresholds", () => {
  const execution_units = [
    unit({ id: "first", estimated_lines: 150, allowed_files: ["src/a.js"] }),
    unit({ id: "second", estimated_lines: 150, depends_on: ["first"], allowed_files: ["src/b.js"] }),
  ];
  const exactThresholds = checkPlan(plan(execution_units), {
    maxFiles: 2,
    maxLines: 300,
    requireWarningDispositions: false,
  });
  assert.ok(exactThresholds.warnings.some((warning) => warning.code === "STRONG_MERGE_CANDIDATE"));

  const tooFewFiles = checkPlan(plan(execution_units), {
    maxFiles: 1,
    maxLines: 300,
    requireWarningDispositions: false,
  });
  assert.equal(tooFewFiles.warnings.some((warning) => warning.code === "STRONG_MERGE_CANDIDATE"), false);

  const tooFewLines = checkPlan(plan(execution_units), {
    maxFiles: 2,
    maxLines: 299,
    requireWarningDispositions: false,
  });
  assert.equal(tooFewLines.warnings.some((warning) => warning.code === "STRONG_MERGE_CANDIDATE"), false);
});

test("missing or malformed cohesion metadata fails instead of suppressing the strong check", () => {
  const valid = gapChain();
  const missing = unit({ id: "missing", allowed_files: ["src/missing.js"] });
  delete missing.user_outcome;
  delete missing.independently_shippable;
  delete missing.review_boundary;
  delete missing.estimated_lines;
  const missingResult = checkPlan(plan([valid[0], missing]), {
    requireWarningDispositions: false,
  });
  assert.deepEqual(
    missingResult.errors
      .filter((error) => error.code === "MISSING_UNIT_METADATA")
      .map((error) => error.field)
      .sort(),
    ["estimated_lines", "independently_shippable", "review_boundary", "user_outcome"],
  );
  assert.equal(missingResult.warnings.some((warning) => warning.code === "STRONG_MERGE_CANDIDATE"), false);

  const malformed = unit({
    id: "malformed",
    user_outcome: 12,
    independently_shippable: "false",
    review_boundary: "invented boundary",
    estimated_lines: "100",
    allowed_files: ["src/malformed.js"],
  });
  const malformedResult = checkPlan(plan([valid[0], malformed]), {
    requireWarningDispositions: false,
  });
  assert.deepEqual(
    malformedResult.errors
      .filter((error) => error.code === "INVALID_UNIT_METADATA")
      .map((error) => error.field)
      .sort(),
    ["estimated_lines", "independently_shippable", "review_boundary", "user_outcome"],
  );
});

test("KEEP_SEPARATE requires an allowed reason code and explanatory text", () => {
  const units = [
    unit({ id: "contract", title: "Maintain public response schema", allowed_files: ["src/contract.js"] }),
    unit({ id: "adapter", title: "Update public response schema adapter", allowed_files: ["src/adapter.js"] }),
  ];
  const warning = checkPlan(plan(units), { requireWarningDispositions: false }).warnings.find(
    (item) => item.code === "MERGE_CANDIDATE",
  );
  assert.ok(warning);

  const disposition = {
    code: warning.code,
    units: warning.units,
    decision: "KEEP_SEPARATE",
    reason: "This split is intentional.",
  };
  const proseOnly = checkPlan(plan(units, [disposition]));
  assert.equal(proseOnly.ok, false);
  assert.ok(proseOnly.errors.some((error) => error.code === "INVALID_WARNING_REASON_CODE"));

  const unsupported = checkPlan(
    plan(units, [{ ...disposition, reason_code: "BECAUSE_I_SAID_SO" }]),
  );
  assert.equal(unsupported.ok, false);
  assert.ok(unsupported.errors.some((error) => error.code === "INVALID_WARNING_REASON_CODE"));

  const supported = checkPlan(
    plan(units, [{ ...disposition, reason_code: "PUBLIC_CONTRACT" }]),
  );
  assert.equal(supported.ok, true, JSON.stringify(supported.errors));

  const unchangedMerged = checkPlan(
    plan(units, [{ ...disposition, decision: "MERGED", reason_code: undefined }]),
  );
  assert.equal(unchangedMerged.ok, false);
  assert.ok(
    unchangedMerged.errors.some(
      (error) => error.code === "MERGED_DISPOSITION_REQUIRES_PLAN_CHANGE",
    ),
  );

  const missingExplanation = checkPlan(
    plan(units, [
      { ...disposition, reason_code: "PUBLIC_CONTRACT", reason: "" },
    ]),
  );
  assert.equal(missingExplanation.ok, false);
  assert.ok(
    missingExplanation.errors.some(
      (error) => error.code === "INVALID_WARNING_DISPOSITION" && /requires a reason/.test(error.message),
    ),
  );
});

test("Markdown cohesion metadata normalizes and survives JSON normalization", () => {
  const markdown = `
## Execution Unit Justification
Number of units: 1
Why not fewer:
- It is one review boundary.
Why not more:
- There are no independent steps.

### Execution Unit 1: One cohesive outcome
- id: cohesive
- Scope:
  - src/archive.js
- user_outcome:   Process src/archives with genuine gaps
- independently_shippable: FALSE
- review_boundary: Subsystem-Boundary
- estimated_lines: 42
- Acceptance criteria:
  - [ ] gaps are retained
- Verification gates:
  1. npm test
`;
  const parsed = parsePlanMarkdown(markdown);
  const [parsedUnit] = parsed.execution_units;
  assert.equal(parsedUnit.user_outcome, "Process src/archives with genuine gaps");
  assert.equal(parsedUnit.independently_shippable, false);
  assert.equal(parsedUnit.review_boundary, "subsystem_boundary");
  assert.equal(parsedUnit.estimated_lines, 42);
  assert.deepEqual(parsedUnit.allowed_files, ["src/archive.js"]);
  assert.deepEqual(normalizePlan(parsed).execution_units[0], parsedUnit);
});
