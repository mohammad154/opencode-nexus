import test from "node:test";
import assert from "node:assert/strict";
import {
  REVIEWER_COMMAND_POLICY_VERSION,
  classifyReviewerCommands,
  isApprovalAdmissible,
  normalizeAdversarialCheck,
  normalizeCommandKey,
  sealedCommandIndex,
} from "../scripts/lib/review-protocol.js";
import { validateHandoff } from "../scripts/lib/schema-validate.js";

const SEALED = {
  ok: true,
  results: [
    { id: "test", command: "npm test", argv: ["npm", "test"], pass: true, status: "PASSED" },
    { id: "lint", command: "npm run lint", argv: ["npm", "run", "lint"], pass: true, status: "PASSED" },
    {
      id: "typecheck",
      command: "npm run typecheck",
      argv: ["npm", "run", "typecheck"],
      pass: false,
      status: "FAILED",
    },
  ],
};

function approvedHandoff(adversarial) {
  return {
    schema_version: "1.2",
    run_id: "pr6",
    unit_or_task: "unit-1",
    agent: "reviewer",
    base_commit: "base111",
    created_at: "2026-09-22T00:00:00.000Z",
    review_scope: "task",
    reviewed_commit: "head222",
    verdict: "APPROVED",
    files_reviewed: ["src/auth.js"],
    acceptance: [
      {
        id: "AC-1",
        status: "PASS",
        evidence: [{ file: "src/auth.js", line: 12, reason: "expiry enforced" }],
      },
    ],
    checks: [
      { category: "correctness", status: "PASS", evidence: "edge cases read" },
      { category: "test_quality", status: "PASS", evidence: "tests hit production" },
      { category: "impact", status: "PASS", evidence: "callers consistent" },
    ],
    ...(adversarial ? { adversarial_checks: adversarial } : {}),
    findings: [],
  };
}

const STATE = {
  run_id: "pr6",
  acceptance_criteria: ["expired tokens are rejected"],
  current_unit: "unit-1",
};

function admit(adversarial) {
  return isApprovalAdmissible(approvedHandoff(adversarial), STATE, {
    review_package: { production_files: ["src/auth.js"] },
    sealed_verification: SEALED,
  });
}

test("analysis-only adversarial checks need no command and stay admissible", () => {
  const result = admit([
    { risk: "expired token accepted", result: "PASS", evidence: "src/auth.js:12 rejects it" },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.command_policy.adversarial_command_count, 0);
  assert.equal(result.command_policy.duplicate_command_count, 0);
  assert.equal(result.command_policy.version, REVIEWER_COMMAND_POLICY_VERSION);
});

test("a focused probe with hypothesis and reason is admissible", () => {
  const result = admit([
    {
      hypothesis: "Malformed token may bypass expiry validation",
      command: "npm test -- tests/auth-expiry.test.js",
      reason: "Existing sealed verification does not exercise this edge case",
      result: "PASS",
      evidence: "tests/auth-expiry.test.js:21 covers it",
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.command_policy.adversarial_command_count, 1);
  assert.equal(result.command_policy.duplicate_command_count, 0);
});

test("re-running a sealed passing command to reconfirm PASS is inadmissible", () => {
  const result = admit([
    {
      hypothesis: "the suite might be flaky",
      command: "npm test",
      reason: "wanted to be sure",
      result: "PASS",
      evidence: "all green again",
    },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /re-ran sealed passing command `npm test`/);
  assert.match(result.errors.join(" "), /consume sealed verification instead of replaying it/);
  assert.equal(result.command_policy.duplicate_command_count, 1);
  assert.equal(result.command_policy.duplicates[0].sealed_step, "test");
});

test("a probe that contradicts sealed evidence is always allowed", () => {
  const result = admit([
    {
      hypothesis: "the sealed suite may hide an environment-dependent failure",
      command: "npm test",
      reason: "sealed run may not cover the CI locale",
      result: "FAIL",
      evidence: "tests/locale.test.js:8 fails under tr-TR",
    },
  ]);
  // The duplicate is still counted, but a contradiction is evidence, not noise.
  assert.equal(result.command_policy.duplicate_command_count, 1);
  assert.equal(result.command_policy.duplicates[0].informative, true);
  assert.equal(
    result.errors.some((error) => /consume sealed verification/.test(error)),
    false,
  );
});

test("a command without a hypothesis or reason is inadmissible", () => {
  const result = admit([
    { risk: "", command: "npm test -- tests/edge.test.js", result: "PASS", evidence: "ran it" },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /without a hypothesis/);
  assert.match(result.errors.join(" "), /without a reason/);
});

test("re-running a sealed FAILED command is not a redundant replay", () => {
  const result = admit([
    {
      hypothesis: "typecheck failure may be stale",
      command: "npm run typecheck",
      reason: "sealed typecheck failed; confirm whether the fix resolves it",
      result: "PASS",
      evidence: "typecheck now clean",
    },
  ]);
  assert.equal(result.command_policy.duplicate_command_count, 0);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("command normalization compares argv, not formatting", () => {
  assert.equal(normalizeCommandKey("  npm   test  "), "npm test");
  assert.equal(normalizeCommandKey(["npm", "test"]), "npm test");
  const index = sealedCommandIndex(SEALED);
  assert.equal(index.get("npm test").pass, true);
  assert.equal(index.get("npm run typecheck").pass, false);
  assert.equal(index.size, 3);
  const check = normalizeAdversarialCheck({
    hypothesis: "h",
    argv: ["npm", "test", "--", "x"],
    reason: "r",
    result: "pass",
  });
  assert.equal(check.command, "npm test -- x");
  assert.equal(check.executed, true);
  assert.equal(check.result, "PASS");
});

test("a review package supplies the sealed command index to the gate", () => {
  const pkg = {
    production_files: ["src/auth.js"],
    sealed_commands: [
      { id: "test", command: "npm test", argv: ["npm", "test"], pass: true, status: "PASSED" },
    ],
  };
  const result = isApprovalAdmissible(
    approvedHandoff([
      {
        hypothesis: "flaky",
        command: "npm test",
        reason: "double-check",
        result: "PASS",
        evidence: "green",
      },
    ]),
    STATE,
    { review_package: pkg },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /re-ran sealed passing command/);
});

test("classification without sealed evidence still requires declarations", () => {
  const policy = classifyReviewerCommands(
    approvedHandoff([{ hypothesis: "h", command: "npm test", result: "PASS", evidence: "e" }]),
    null,
  );
  assert.equal(policy.sealed_command_count, 0);
  assert.equal(policy.duplicate_command_count, 0);
  assert.equal(policy.adversarial_command_count, 1);
  assert.match(policy.errors.join(" "), /without a reason/);
});

test("schema 1.2 accepts hypothesis/command/reason probes and keeps risk entries", () => {
  const withProbe = validateHandoff("reviewer", 
    approvedHandoff([
      {
        hypothesis: "Malformed token may bypass expiry validation",
        command: "npm test -- tests/auth-expiry.test.js",
        reason: "sealed verification does not exercise it",
        result: "FAIL",
        evidence: "src/auth.js:88 accepts an expired token",
      },
      { risk: "legacy style entry", result: "PASS", evidence: "analyzed only" },
    ]),
  );
  assert.equal(withProbe.ok, true, JSON.stringify(withProbe.errors));

  const missingHypothesis = validateHandoff("reviewer", 
    approvedHandoff([{ result: "PASS", evidence: "no risk or hypothesis" }]),
  );
  assert.equal(missingHypothesis.ok, false);
});
