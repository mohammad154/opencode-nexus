/**
 * PR6.D: reviewer command usage is measured at the gate.
 *
 * The state machine records how a reviewer used its command allowance whenever a
 * reviewer handoff is accepted, so a declared replay of sealed deterministic
 * evidence stays observable even in the cases where it is admissible (a probe
 * that contradicts the sealed result).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { transition } from "../scripts/lib/state-machine.js";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import {
  goodReviewerHandoff,
  mockTrustProviders,
  sealedImpact,
} from "./helpers/gate-fixtures.js";

const SEALED = {
  ok: true,
  results: [
    { id: "test", command: "npm test", argv: ["npm", "test"], pass: true, status: "PASSED" },
  ],
};

function requestChangesWith(adversarial) {
  return goodReviewerHandoff({
    run_id: "pr6-metrics",
    unit_or_task: "unit-1",
    verdict: "REQUEST_CHANGES",
    findings: [
      {
        id: "f1",
        severity: "HIGH",
        title: "blocking defect",
        evidence: "src/app.js:10",
        blocking: true,
      },
    ],
    adversarial_checks: adversarial,
  });
}

function remediationTransition(adversarial) {
  const events = [];
  const providers = mockTrustProviders({
    impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
    extra: { telemetry: { emit: (event) => events.push(event) } },
  });
  const state = {
    ...createEmptyRunState("pr6-metrics"),
    state: "REVIEWING",
    current_unit: "unit-1",
    implementer_commit: "impl222",
    head_commit: "base111",
    provider_verification: SEALED,
  };
  const result = transition(
    state,
    "TASK_IMPACT_READY",
    {
      review_handoff: requestChangesWith(adversarial),
      planned_targets: ["src/app.js"],
      impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
    },
    providers,
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return {
    state: result.state,
    events: events.filter((event) => event.event === "review_commands"),
  };
}

test("a reviewer that consumed sealed evidence records zero commands", () => {
  const { state, events } = remediationTransition([
    { risk: "expired token accepted", result: "FAIL", evidence: "src/app.js:10" },
  ]);
  assert.equal(state.last_review_command_policy.adversarial_command_count, 0);
  assert.equal(state.last_review_command_policy.duplicate_command_count, 0);
  assert.equal(state.last_review_command_policy.sealed_command_count, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].reviewer_adversarial_command_count, 0);
  assert.equal(events[0].reviewer_duplicate_command_count, 0);
  assert.equal(events[0].kind, "task");
});

test("a focused probe is counted as an adversarial command, not a duplicate", () => {
  const { state, events } = remediationTransition([
    {
      hypothesis: "malformed token may bypass expiry",
      command: "npm test -- tests/auth-expiry.test.js",
      reason: "sealed verification does not exercise it",
      result: "FAIL",
      evidence: "tests/auth-expiry.test.js:21 fails",
    },
  ]);
  assert.equal(state.last_review_command_policy.adversarial_command_count, 1);
  assert.equal(state.last_review_command_policy.duplicate_command_count, 0);
  assert.equal(events[0].reviewer_adversarial_command_count, 1);
  assert.equal(events[0].reviewer_duplicate_command_count, 0);
});

test("a replay of sealed passing evidence is recorded even when tolerated", () => {
  const { state, events } = remediationTransition([
    {
      hypothesis: "the sealed suite may hide a locale failure",
      command: "npm test",
      reason: "sealed run may not cover tr-TR",
      result: "FAIL",
      evidence: "tests/locale.test.js:8 fails",
    },
  ]);
  const policy = state.last_review_command_policy;
  assert.equal(policy.adversarial_command_count, 1);
  assert.equal(policy.duplicate_command_count, 1);
  assert.equal(policy.duplicates[0].command, "npm test");
  assert.equal(policy.duplicates[0].sealed_step, "test");
  assert.equal(policy.duplicates[0].informative, true);
  assert.equal(events[0].reviewer_duplicate_command_count, 1);
});
