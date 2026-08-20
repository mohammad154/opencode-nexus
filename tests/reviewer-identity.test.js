import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import { canTransition, transition } from "../scripts/lib/state-machine.js";
import { validateHandoff } from "../scripts/lib/schema-validate.js";
import {
  goodImplementerHandoff,
  goodUnifiedHandoff,
  goodIntegrationHandoff,
  handoffEnvelope,
} from "./helpers/gate-fixtures.js";

function goodSpecHandoff(overrides = {}) {
  return {
    ...handoffEnvelope({ agent: "spec-reviewer" }),
    verdict: "APPROVED",
    reviewed_commit: "impl222",
    blast: { pass: true, risk: "LOW" },
    acceptance: [],
    findings: [],
    ...overrides,
  };
}

function goodCodeHandoff(overrides = {}) {
  return {
    ...handoffEnvelope({ agent: "code-reviewer" }),
    verdict: "APPROVED",
    reviewed_commit: "impl222",
    blast: { pass: true, risk: "LOW" },
    findings: [],
    security: { issues: 0 },
    verification_gates_verified: true,
    ...overrides,
  };
}

function baseReviewingState(overrides = {}) {
  return {
    ...createEmptyRunState("run-reviewer-test"),
    state: "REVIEWING",
    review_level: "unified",
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

// ---------------------------------------------------------------------------
// Schema validation for agent enum
// ---------------------------------------------------------------------------

test("schema: spec-reviewer schema validates agent === 'spec-reviewer' and rejects others", () => {
  const valid = goodSpecHandoff();
  assert.equal(validateHandoff("spec-reviewer", valid).ok, true);

  const invalid = goodSpecHandoff({ agent: "implementer" });
  const r = validateHandoff("spec-reviewer", invalid);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes("agent")));
});

test("schema: code-reviewer schema validates agent === 'code-reviewer' and rejects others", () => {
  const valid = goodCodeHandoff();
  assert.equal(validateHandoff("code-reviewer", valid).ok, true);

  const invalid = goodCodeHandoff({ agent: "implementer" });
  const r = validateHandoff("code-reviewer", invalid);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes("agent")));
});

test("schema: integration-reviewer schema validates agent === 'integration-reviewer' and rejects others", () => {
  const valid = goodIntegrationHandoff();
  assert.equal(validateHandoff("integration-reviewer", valid).ok, true);

  const invalid = goodIntegrationHandoff({ agent: "code-reviewer" });
  const r = validateHandoff("integration-reviewer", invalid);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes("agent")));
});

test("schema: unified-reviewer schema validates agent === 'unified-reviewer' and rejects others", () => {
  const valid = goodUnifiedHandoff();
  assert.equal(validateHandoff("unified-reviewer", valid).ok, true);

  const invalid = goodUnifiedHandoff({ agent: "implementer" });
  const r = validateHandoff("unified-reviewer", invalid);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes("agent")));
});

// ---------------------------------------------------------------------------
// Unified review identity & anti-self-approval
// ---------------------------------------------------------------------------

test("unified review accepts valid unified-reviewer agent", () => {
  const state = baseReviewingState({ review_level: "unified" });
  const r = canTransition(state, "FINAL_VERIFYING", {
    unified_handoff: goodUnifiedHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "unified-reviewer",
    }),
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("unified review rejects when unified agent is not unified-reviewer", () => {
  const state = baseReviewingState({ review_level: "unified" });
  const r = canTransition(state, "FINAL_VERIFYING", {
    unified_handoff: goodUnifiedHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "custom-reviewer",
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /unified-reviewer|invalid|agent/i.test(e)),
    JSON.stringify(r.errors),
  );
});

test("unified review rejects when unified agent is implementer", () => {
  const state = baseReviewingState({
    review_level: "unified",
    last_implementer_handoff: goodImplementerHandoff({
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
      base_commit: "base111",
      commit: "impl222",
      agent: "unified-reviewer",
    }),
  });
  const r = canTransition(state, "FINAL_VERIFYING", {
    unified_handoff: goodUnifiedHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "unified-reviewer",
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /self-approval|matches implementer/i.test(e)),
    JSON.stringify(r.errors),
  );
});

// ---------------------------------------------------------------------------
// Dual review identity & anti-self-approval & distinctness
// ---------------------------------------------------------------------------

test("dual review accepts valid spec-reviewer and code-reviewer agents", () => {
  const state = baseReviewingState({ review_level: "dual" });
  const r = canTransition(state, "FINAL_VERIFYING", {
    spec_handoff: goodSpecHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "spec-reviewer",
    }),
    code_handoff: goodCodeHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "code-reviewer",
    }),
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("dual review rejects when spec-reviewer agent is not spec-reviewer", () => {
  const state = baseReviewingState({ review_level: "dual" });
  const r = canTransition(state, "FINAL_VERIFYING", {
    spec_handoff: goodSpecHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "arbitrary-spec",
    }),
    code_handoff: goodCodeHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "code-reviewer",
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /spec-reviewer|invalid|agent/i.test(e)),
    JSON.stringify(r.errors),
  );
});

test("dual review rejects when code-reviewer agent is not code-reviewer", () => {
  const state = baseReviewingState({ review_level: "dual" });
  const r = canTransition(state, "FINAL_VERIFYING", {
    spec_handoff: goodSpecHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "spec-reviewer",
    }),
    code_handoff: goodCodeHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "arbitrary-code",
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /code-reviewer|invalid|agent/i.test(e)),
    JSON.stringify(r.errors),
  );
});

test("dual review rejects when spec-reviewer agent is implementer", () => {
  const state = baseReviewingState({
    review_level: "dual",
    last_implementer_handoff: goodImplementerHandoff({
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
      base_commit: "base111",
      commit: "impl222",
      agent: "spec-reviewer",
    }),
  });
  const r = canTransition(state, "FINAL_VERIFYING", {
    spec_handoff: goodSpecHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "spec-reviewer",
    }),
    code_handoff: goodCodeHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "code-reviewer",
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /self-approval|spec-reviewer.*implementer/i.test(e)),
    JSON.stringify(r.errors),
  );
});

test("dual review rejects when code-reviewer agent is implementer", () => {
  const state = baseReviewingState({
    review_level: "dual",
    last_implementer_handoff: goodImplementerHandoff({
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
      base_commit: "base111",
      commit: "impl222",
      agent: "code-reviewer",
    }),
  });
  const r = canTransition(state, "FINAL_VERIFYING", {
    spec_handoff: goodSpecHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "spec-reviewer",
    }),
    code_handoff: goodCodeHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "code-reviewer",
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /self-approval|code-reviewer.*implementer/i.test(e)),
    JSON.stringify(r.errors),
  );
});

test("dual review rejects when code-reviewer is same agent as spec-reviewer", () => {
  const state = baseReviewingState({ review_level: "dual" });
  const r = canTransition(state, "FINAL_VERIFYING", {
    spec_handoff: goodSpecHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "shared-reviewer",
    }),
    code_handoff: goodCodeHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "shared-reviewer",
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /same agent|distinct|cannot also be code reviewer/i.test(e)),
    JSON.stringify(r.errors),
  );
});

// ---------------------------------------------------------------------------
// Multi-task integration review identity & anti-self-approval
// ---------------------------------------------------------------------------

test("multi-task integration review accepts valid integration-reviewer agent", () => {
  const state = baseReviewingState({
    review_level: "unified",
    units: 2,
  });
  const r = canTransition(state, "FINAL_VERIFYING", {
    unified_handoff: goodUnifiedHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "unified-reviewer",
    }),
    integration_handoff: goodIntegrationHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "integration-reviewer",
    }),
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("integration review rejects when agent is not integration-reviewer", () => {
  const state = baseReviewingState({
    review_level: "unified",
    units: 2,
  });
  const r = canTransition(state, "FINAL_VERIFYING", {
    unified_handoff: goodUnifiedHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "unified-reviewer",
    }),
    integration_handoff: goodIntegrationHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "code-reviewer",
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /integration-reviewer|invalid|agent/i.test(e)),
    JSON.stringify(r.errors),
  );
});

test("multi-task integration review rejects when integration agent is implementer", () => {
  const state = baseReviewingState({
    review_level: "unified",
    units: 2,
    last_implementer_handoff: goodImplementerHandoff({
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
      base_commit: "base111",
      commit: "impl222",
      agent: "integration-reviewer",
    }),
  });
  const r = canTransition(state, "FINAL_VERIFYING", {
    unified_handoff: goodUnifiedHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "unified-reviewer",
    }),
    integration_handoff: goodIntegrationHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "integration-reviewer",
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /self-approval|integration-reviewer.*implementer/i.test(e)),
    JSON.stringify(r.errors),
  );
});

// ---------------------------------------------------------------------------
// COMPLETED with legacy_skip_final enforcement
// ---------------------------------------------------------------------------

test("COMPLETED via legacy_skip_final rejects self-approval in dual review", () => {
  const state = baseReviewingState({
    review_level: "dual",
    compatibility_mode: "v3",
    last_implementer_handoff: goodImplementerHandoff({
      run_id: "run-reviewer-test",
      unit_or_task: "unit-1",
      base_commit: "base111",
      commit: "impl222",
      agent: "spec-reviewer",
    }),
  });
  const r = canTransition(state, "COMPLETED", {
    legacy_skip_final: true,
    spec_handoff: goodSpecHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "spec-reviewer",
    }),
    code_handoff: goodCodeHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "code-reviewer",
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /self-approval|spec-reviewer.*implementer/i.test(e)),
    JSON.stringify(r.errors),
  );
});

test("COMPLETED via legacy_skip_final rejects spec and code sharing agent", () => {
  const state = baseReviewingState({
    review_level: "dual",
    compatibility_mode: "v3",
  });
  const r = canTransition(state, "COMPLETED", {
    legacy_skip_final: true,
    spec_handoff: goodSpecHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "same-reviewer",
    }),
    code_handoff: goodCodeHandoff({
      run_id: state.run_id,
      unit_or_task: state.current_unit,
      agent: "same-reviewer",
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /same agent|distinct|cannot also be code reviewer/i.test(e)),
    JSON.stringify(r.errors),
  );
});
