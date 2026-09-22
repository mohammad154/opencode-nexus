import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_CONTRACT_VERSION,
  checkPlan,
  parsePlanMarkdown,
  planContract,
} from "../scripts/lib/plan-check.js";

const COMPACT_PLAN = `# Plan: cache-key-fix

- Planning mode: compact
- Plan commit: abc1234

## Goal
Prevent cache reuse across different request identities.

## Non-goals
- No cache backend redesign.

### Execution Unit 1: Correct cache identity
- id: unit-1
- user_outcome: Cache entries cannot leak between different keys.
- independently_shippable: true
- review_boundary: NONE
- estimated_lines: 60
- Evidence:
  - \`src/cache.js:42-70\`
- Scope:
  - In: \`src/cache.js\`, \`tests/cache.test.js\`
- Acceptance criteria:
  - [ ] same key still reuses
  - [ ] different key cannot reuse
- Verification gates:
  1. \`npm test -- tests/cache.test.js\`
- STOP conditions:
  - STOP if public cache contract must change.
`;

test("a minimal compact plan passes without the decomposition essay", () => {
  const result = checkPlan(COMPACT_PLAN);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.plan_check, "PASS");
  assert.equal(result.planning_mode, "compact");
  assert.equal(result.contract.version, PLAN_CONTRACT_VERSION);
  assert.equal(result.contract.compact_document, true);
  assert.equal(
    result.contract.required_sections.includes("execution_unit_justification"),
    false,
  );
  for (const relaxed of [
    "findings_triage",
    "dependency_diagram",
    "global_verification_strategy",
    "rollback_section",
    "outcome_memory_section",
    "implementation_sketch",
  ]) {
    assert.ok(result.contract.relaxed_sections.includes(relaxed), relaxed);
  }
  assert.equal(result.goal, "Prevent cache reuse across different request identities.");
  assert.deepEqual(result.non_goals, ["No cache backend redesign."]);
  assert.equal(result.plan_commit, "abc1234");
  assert.equal(typeof result.plan_bytes, "number");
  assert.equal(result.estimate.plan_advisor_calls, 0);
});

test("the compact contract stays small: 11 required sections, 8 relaxed", () => {
  const contract = planContract("compact", 1);
  assert.equal(contract.required_sections.length, 11);
  assert.equal(contract.relaxed_sections.length, 8);
  // Regression guard for PR5's purpose: a complete, valid compact plan for a
  // one-unit change stays roughly a page, not a template.
  const result = checkPlan(COMPACT_PLAN);
  assert.equal(result.ok, true);
  assert.ok(
    result.plan_bytes < 1200,
    `compact plan grew to ${result.plan_bytes} bytes`,
  );
});

test("compact parsing captures structured evidence and STOP conditions", () => {
  const parsed = parsePlanMarkdown(COMPACT_PLAN);
  const [unit] = parsed.execution_units;
  assert.equal(parsed.planning_mode, "compact");
  assert.equal(parsed.plan_commit, "abc1234");
  assert.deepEqual(parsed.non_goals, ["No cache backend redesign."]);
  assert.deepEqual(unit.evidence, ["`src/cache.js:42-70`"]);
  assert.deepEqual(unit.stop_conditions, [
    "STOP if public cache contract must change.",
  ]);
  assert.deepEqual(unit.allowed_files, ["src/cache.js", "tests/cache.test.js"]);
  assert.deepEqual(unit.acceptance_criteria, [
    "same key still reuses",
    "different key cannot reuse",
  ]);
  assert.deepEqual(unit.verification_gates, ["`npm test -- tests/cache.test.js`"]);
});

test("every mode requires goal, non-goals, plan commit, evidence, and STOP", () => {
  const cases = [
    ["MISSING_PLAN_GOAL", COMPACT_PLAN.replace("## Goal\nPrevent cache reuse across different request identities.\n", "")],
    ["MISSING_PLAN_NON_GOALS", COMPACT_PLAN.replace("## Non-goals\n- No cache backend redesign.\n", "")],
    ["MISSING_PLAN_COMMIT", COMPACT_PLAN.replace("- Plan commit: abc1234\n", "")],
    ["MISSING_UNIT_EVIDENCE", COMPACT_PLAN.replace("- Evidence:\n  - `src/cache.js:42-70`\n", "")],
    [
      "MISSING_STOP_CONDITIONS",
      COMPACT_PLAN.replace(
        "- STOP conditions:\n  - STOP if public cache contract must change.\n",
        "",
      ),
    ],
  ];
  for (const [code, text] of cases) {
    const result = checkPlan(text);
    assert.equal(result.ok, false, code);
    assert.ok(
      result.errors.some((error) => error.code === code),
      `${code} missing from ${JSON.stringify(result.errors.map((e) => e.code))}`,
    );
  }
});

test("a compact plan with multiple units falls back to the standard contract", () => {
  const multiUnit = `${COMPACT_PLAN}
### Execution Unit 2: Second behavior
- id: unit-2
- user_outcome: Second behavior is available to callers.
- independently_shippable: true
- review_boundary: NONE
- estimated_lines: 40
- Evidence:
  - \`src/second.js:10\`
- Scope:
  - In: \`src/second.js\`
- Acceptance criteria:
  - [ ] second behavior works
- Verification gates:
  1. \`npm test -- tests/second.test.js\`
- STOP conditions:
  - STOP if \`src/second.js\` is missing.
`;
  const result = checkPlan(multiUnit, { requireWarningDispositions: false });
  assert.equal(result.contract.compact_document, false);
  assert.ok(
    result.warnings.some((warning) => warning.code === "COMPACT_PLAN_MULTIPLE_UNITS"),
  );
  assert.ok(
    result.errors.some((error) => error.code === "MISSING_UNIT_JUSTIFICATION"),
    "the decomposition essay is required once there is a decomposition",
  );
  assert.equal(result.ok, false);
});

test("standard and deep plans keep the decomposition essay required", () => {
  for (const mode of ["standard", "deep"]) {
    const contract = planContract(mode, 1);
    assert.equal(contract.compact_document, false);
    assert.ok(contract.required_sections.includes("execution_unit_justification"));
    assert.deepEqual(contract.relaxed_sections, []);

    const result = checkPlan(COMPACT_PLAN.replace("compact", mode));
    assert.equal(result.ok, false, mode);
    assert.ok(
      result.errors.some((error) => error.code === "MISSING_UNIT_JUSTIFICATION"),
      mode,
    );
  }
});

test("the writing-plans generation banner satisfies the plan commit requirement", () => {
  const banner = COMPACT_PLAN.replace(
    "- Plan commit: abc1234",
    "> Generated by writing-plans against commit abc1234 (abc1234def) on branch main",
  );
  const result = checkPlan(banner);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.plan_commit, "abc1234");
});

test("a declared compact mode is a document shape, not planning authority", () => {
  // plan-check validates structure only. Compact admissibility stays with the
  // PLANNED gate's re-derived planning evidence (PR4), which is why a compact
  // document for a security boundary can still be structurally valid here.
  const securityPlan = COMPACT_PLAN.replace(
    "Prevent cache reuse across different request identities.",
    "Rework the authentication session token boundary.",
  );
  const result = checkPlan(securityPlan);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.planning_mode, "compact");
});
