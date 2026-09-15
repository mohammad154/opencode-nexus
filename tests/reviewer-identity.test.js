import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import { canTransition, transition } from "../scripts/lib/state-machine.js";
import { validateHandoff } from "../scripts/lib/schema-validate.js";
import {
  goodImplementerHandoff,
  goodReviewerHandoff,
  goodReviewPackage,
  finalReviewingState,
  finalVerifyingEvidence,
} from "./helpers/gate-fixtures.js";

function baseReviewingState(overrides = {}) {
  return {
    ...createEmptyRunState("run-reviewer-test"),
    state: "REVIEWING",
    current_unit: "unit-1",
    implementer_commit: "impl222",
    head_commit: "base111",
    last_implementer_handoff: goodImplementerHandoff({
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
      base_commit: "base111",
      commit: "impl222",
      agent: "implementer",
    }),
    ...overrides,
  };
}

test("schema: reviewer validates agent === 'reviewer' and rejects implementer", () => {
  const valid = goodReviewerHandoff({ run_id: "run-reviewer-test" });
  assert.equal(validateHandoff("reviewer", valid).ok, true);

  const invalid = goodReviewerHandoff({
    run_id: "run-reviewer-test",
    agent: "implementer",
  });
  const r = validateHandoff("reviewer", invalid);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes("agent")));
});

test("FINAL_REVIEWING accepts task-scope APPROVED with review package", () => {
  const state = baseReviewingState();
  const ok = canTransition(state, "FINAL_REVIEWING", {
    review_handoff: goodReviewerHandoff({
      run_id: "run-reviewer-test",
      review_scope: "task",
    }),
    review_package: goodReviewPackage({
      scope: "task",
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
    }),
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test("same-unit APPROVED review clears that unit's prior blocking findings", () => {
  const oldFinding = {
    id: "F-OLD",
    title: "Finding fixed in the current commit",
    severity: "HIGH",
    blocking: true,
  };
  const state = baseReviewingState({
    last_review_handoff: goodReviewerHandoff({
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
      verdict: "REQUEST_CHANGES",
      findings: [oldFinding],
    }),
    pending_review_findings: [oldFinding],
  });
  const result = transition(state, "FINAL_REVIEWING", {
    review_handoff: goodReviewerHandoff({
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
      review_scope: "task",
      reviewed_commit: "impl222",
    }),
    review_package: goodReviewPackage({
      scope: "task",
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
    }),
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.state.pending_review_findings, null);
  assert.equal(result.state.pending_review_unit, null);
});

test("same-unit approval does not clear findings from another unit", () => {
  const oldFinding = {
    id: "F-OTHER",
    title: "Unresolved finding from another unit",
    severity: "HIGH",
    blocking: true,
  };
  const state = baseReviewingState({
    last_review_handoff: goodReviewerHandoff({
      run_id: "run-reviewer-test",
      unit_or_task: "unit-0",
      verdict: "REQUEST_CHANGES",
      findings: [oldFinding],
    }),
    pending_review_findings: [oldFinding],
  });
  const result = canTransition(state, "FINAL_REVIEWING", {
    review_handoff: goodReviewerHandoff({
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
      review_scope: "task",
      reviewed_commit: "impl222",
    }),
    review_package: goodReviewPackage({
      scope: "task",
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /unresolved findings: F-OTHER/);
});

test("final approval can proceed after a same-unit task approval cleared old findings", () => {
  const oldFinding = {
    id: "F-OLD",
    title: "Finding fixed in the current commit",
    severity: "HIGH",
    blocking: true,
  };
  const taskApproval = goodReviewerHandoff({
    run_id: "run-reviewer-test",
    unit_or_task: "unit-1",
    review_scope: "task",
  });
  const state = finalReviewingState({
    ...createEmptyRunState("run-reviewer-test"),
    current_unit: "unit-1",
    implementer_commit: "impl222",
    head_commit: "base111",
    last_task_review_handoff: taskApproval,
    last_review_handoff: taskApproval,
    pending_review_findings: [oldFinding],
  });
  const result = canTransition(
    state,
    "FINAL_VERIFYING",
    finalVerifyingEvidence({ run_id: "run-reviewer-test" }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("FINAL_VERIFYING requires final-scope APPROVED", () => {
  const state = finalReviewingState({
    ...createEmptyRunState("run-reviewer-test"),
    current_unit: "unit-1",
    implementer_commit: "impl222",
    head_commit: "base111",
    last_implementer_handoff: goodImplementerHandoff({
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
      base_commit: "base111",
      commit: "impl222",
      agent: "implementer",
    }),
  });
  const ok = canTransition(state, "FINAL_VERIFYING", finalVerifyingEvidence({
    run_id: "run-reviewer-test",
  }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test("FINAL_VERIFYING rejects REQUEST_CHANGES", () => {
  const state = finalReviewingState({
    ...createEmptyRunState("run-reviewer-test"),
    implementer_commit: "impl222",
  });
  const r = canTransition(state, "FINAL_VERIFYING", {
    review_handoff: goodReviewerHandoff({
      run_id: "run-reviewer-test",
      review_scope: "final",
      verdict: "REQUEST_CHANGES",
    }),
    review_package: goodReviewPackage({ scope: "final" }),
  });
  assert.equal(r.ok, false);
});

test("no self-approval when implementer agent equals reviewer", () => {
  const state = finalReviewingState({
    ...createEmptyRunState("run-reviewer-test"),
    implementer_commit: "impl222",
    last_implementer_handoff: goodImplementerHandoff({
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
      agent: "reviewer",
      commit: "impl222",
      base_commit: "base111",
    }),
  });
  const r = canTransition(state, "FINAL_VERIFYING", finalVerifyingEvidence({
    run_id: "run-reviewer-test",
  }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /self-approval/i);
});

test("reviewed_commit must match implementer_commit", () => {
  const state = finalReviewingState({
    ...createEmptyRunState("run-reviewer-test"),
    implementer_commit: "impl222",
  });
  const r = canTransition(state, "FINAL_VERIFYING", finalVerifyingEvidence({
    run_id: "run-reviewer-test",
    final_overrides: { reviewed_commit: "wrong" },
  }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /reviewed_commit/);
});

test("REVIEWING → FINAL_VERIFYING is illegal (must FINAL_REVIEWING)", () => {
  const state = baseReviewingState();
  const r = canTransition(state, "FINAL_VERIFYING", finalVerifyingEvidence({
    run_id: "run-reviewer-test",
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /illegal transition|FINAL_REVIEWING/i.test(e)));
});
