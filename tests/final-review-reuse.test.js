import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import { canTransition, transition } from "../scripts/lib/state-machine.js";
import {
  goodReviewerHandoff,
  goodReviewPackage,
} from "./helpers/gate-fixtures.js";

function singleUnitReviewState(overrides = {}) {
  return {
    ...createEmptyRunState("reuse-run"),
    state: "REVIEWING",
    current_unit: "unit-1",
    execution_units: [{ id: "unit-1" }],
    units: [{ id: "unit-1" }],
    acceptance_criteria: ["done"],
    implementer_commit: "impl222",
    head_commit: "impl222",
    last_implementer_handoff: { agent: "implementer" },
    ...overrides,
  };
}

function reuseEvidence(overrides = {}) {
  const review_handoff = goodReviewerHandoff({
    run_id: "reuse-run",
    unit_or_task: "unit-1",
    review_scope: "task",
    reviewed_commit: "impl222",
  });
  return {
    reuse_final_review: true,
    current_head: "impl222",
    review_handoff,
    review_package: goodReviewPackage({
      run_id: "reuse-run",
      unit_or_task: "unit-1",
      scope: "task",
      head_commit: "impl222",
      digest_sha256: "fixture",
    }),
    ...overrides,
  };
}

test("single-unit final review reuse requires explicit bound evidence", () => {
  const state = singleUnitReviewState();
  const evidence = reuseEvidence();
  const check = canTransition(state, "FINAL_VERIFYING", evidence);
  assert.equal(check.ok, true, JSON.stringify(check.errors));

  const result = transition(state, "FINAL_VERIFYING", evidence);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.state.final_review_reused, true);
  assert.equal(result.state.agent_calls_used, 1);
});

test("single-unit final review reuse rejects multiple units and stale HEAD", () => {
  const multiple = singleUnitReviewState({
    execution_units: [{ id: "unit-1" }, { id: "unit-2" }],
    units: [{ id: "unit-1" }, { id: "unit-2" }],
  });
  const multiResult = canTransition(multiple, "FINAL_VERIFYING", reuseEvidence());
  assert.equal(multiResult.ok, false);
  assert.match(multiResult.errors.join(" "), /exactly one execution unit/i);

  const stale = canTransition(
    singleUnitReviewState({ implementer_commit: "new-head", head_commit: "new-head" }),
    "FINAL_VERIFYING",
    reuseEvidence(),
  );
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join(" "), /final HEAD|head_commit/i);
});

test("standard planning requires one advisor and rejects an over-budget advisor claim", () => {
  const state = {
    ...createEmptyRunState("planning-run"),
    state: "BRAINSTORMING",
  };
  const missing = canTransition(state, "PLANNED", {
    plan_exists: true,
    planning_mode: "standard",
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(" "), /plan-advisor/i);

  const over = canTransition(state, "PLANNED", {
    plan_exists: true,
    planning_mode: "standard",
    plan_advisor: {
      agent: "plan-advisor",
      calls: 2,
      read_only: true,
      model: "openai/gpt-5-mini",
    },
  });
  assert.equal(over.ok, false);
  assert.match(over.errors.join(" "), /permits 1/i);
});

test("standard planning rejects an incomplete advisor handoff", () => {
  const state = {
    ...createEmptyRunState("planning-incomplete-advisor"),
    state: "BRAINSTORMING",
  };
  const result = canTransition(state, "PLANNED", {
    plan_exists: true,
    planning_mode: "standard",
    plan_advisor: {
      calls: 0,
      model: "openai/gpt-5-mini",
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /plan-advisor|read_only/i);
});
