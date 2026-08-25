/**
 * V5 gate hardening — fixed pipeline invariants.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyRunState } from "../../scripts/lib/migrate-artifacts.js";
import {
  canTransition,
  transition,
} from "../../scripts/lib/state-machine.js";
import { assertValidRunId } from "../../scripts/lib/policy.js";
import { normalizeHandoff } from "../../scripts/lib/migrate-artifacts.js";
import {
  goodImplementerHandoff,
  goodReviewerHandoff,
  goodReviewPackage,
  finalReviewingState,
  finalVerifyingEvidence,
  mockTrustProviders,
  sealedImpact,
  sealedVerification,
} from "../helpers/gate-fixtures.js";

function driftOk(head = "base111") {
  return {
    schema_version: "1.0",
    plan_commit: head,
    current_head: head,
    drift: "NONE",
    reasons: [],
  };
}

function toPlanned(runId = "gate") {
  let s = createEmptyRunState(runId);
  s = transition(s, "BRAINSTORMING", {}).state;
  s = transition(s, "PLANNED", { plan_exists: true }).state;
  return s;
}

test("assertValidRunId rejects path separators", () => {
  assert.throws(() => assertValidRunId("../x"));
  assert.equal(assertValidRunId("ok-run_1"), "ok-run_1");
});

test("IMPLEMENTING without drift is rejected", () => {
  const providers = mockTrustProviders({
    impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
  });
  let state = toPlanned("g-drift");
  state = transition(
    state,
    "TASK_IMPACT_READY",
    {
      planned_targets: ["src/app.js"],
      impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
    },
    providers,
  ).state;
  const r = canTransition(state, "IMPLEMENTING", {
    branch: "feat/x",
    acceptance_criteria: ["a"],
    allowed_files: ["src/app.js"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /drift/i.test(e)));
});

test("pre-impact can enter TASK_IMPACT_READY without trusted label", () => {
  const providers = mockTrustProviders({
    impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
  });
  let state = toPlanned("g-pre");
  const r = transition(
    state,
    "TASK_IMPACT_READY",
    {
      planned_targets: ["src/app.js"],
      impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
    },
    providers,
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.require_post_impact, true);
});

test("REVIEWING → COMPLETED is illegal (must FINAL_VERIFYING)", () => {
  const state = {
    ...createEmptyRunState("g-complete"),
    state: "REVIEWING",
    implementer_commit: "impl222",
  };
  const r = canTransition(state, "COMPLETED", {
    review_handoff: goodReviewerHandoff({ run_id: "g-complete" }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /illegal transition/i.test(e)));
});

test("multi-task FINAL_VERIFYING does not require integration-reviewer", () => {
  const state = finalReviewingState({
    ...createEmptyRunState("g-multi"),
    implementer_commit: "impl222",
    current_unit: "unit-1",
    tasks: ["a", "b"],
  });
  const r = canTransition(
    state,
    "FINAL_VERIFYING",
    finalVerifyingEvidence({ run_id: "g-multi" }),
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("normalizeHandoff remaps legacy unified-reviewer agent to reviewer", () => {
  const { data } = normalizeHandoff("unified-reviewer", {
    schema_version: "1.1",
    run_id: "x",
    unit_or_task: "u",
    agent: "unified-reviewer",
    base_commit: null,
    created_at: "2026-01-01T00:00:00.000Z",
    verdict: "APPROVED",
    reviewed_commit: "c",
  });
  assert.equal(data.agent, "reviewer");
  assert.equal(data.schema_version, "1.2");
});

test("VERIFYING requires sealed provider verification path via gates", () => {
  let state = {
    ...createEmptyRunState("g-ver"),
    state: "IMPLEMENTING",
    head_commit: "base111",
    current_unit: "unit-1",
    allowed_files: ["src/app.js"],
    require_post_impact: true,
  };
  const r = canTransition(state, "VERIFYING", {
    implementer_handoff: goodImplementerHandoff({ run_id: "g-ver" }),
  });
  // May fail on provider verification / post-impact — must not silently pass
  assert.equal(r.ok, false);
});

test("force_reimpact cannot bypass missing review_handoff on REVIEWING→TASK_IMPACT_READY", () => {
  let state = createEmptyRunState("g-force");
  state.state = "REVIEWING";
  state.implementer_commit = "impl222";
  state.current_unit = "unit-1";
  const r = canTransition(state, "TASK_IMPACT_READY", {
    force_reimpact: true,
    impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /review_handoff/i.test(e)));
});

test("fabricated trusted impact rejected at TASK_IMPACT_READY without provider", () => {
  let state = toPlanned("g-fab");
  const r = canTransition(state, "TASK_IMPACT_READY", {
    impact: {
      risk: "LOW",
      trusted: true,
      fabricated: true,
      planned_targets: ["src/app.js"],
    },
  });
  assert.equal(r.ok, false);
});
