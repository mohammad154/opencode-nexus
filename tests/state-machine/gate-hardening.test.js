import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyRunState } from "../../scripts/lib/migrate-artifacts.js";
import { canTransition, transition } from "../../scripts/lib/state-machine.js";
import { classify, loadWorkflowConfig } from "../../scripts/lib/classify.js";
import {
  assessDrift,
  isPlanCommitAcceptable,
} from "../../scripts/lib/drift.js";
import { assertValidRunId } from "../../scripts/lib/policy.js";
import { normalizeHandoff } from "../../scripts/lib/migrate-artifacts.js";

function sampleClassification(overrides = {}) {
  return {
    schema_version: "1.0",
    profile: "balanced",
    review_level: "dual",
    execution_mode: "delegated",
    risk_score: 4,
    confidence: 0.8,
    reasons: ["test"],
    direct_eligible: false,
    change_class: "small-feature-with-tests",
    hard_triggers: [],
    ...overrides,
  };
}

function goodDrift() {
  return {
    schema_version: "1.0",
    drift: "NONE",
    reasons: [],
    commit_distance: 0,
    plan_commit: "abc",
    current_head: "def",
    anchors_broken: [],
    merge_base_changed: false,
  };
}

test("ctx review_level none cannot downgrade stored dual", () => {
  const state = {
    ...createEmptyRunState("gate-1"),
    state: "VERIFYING",
    review_level: "dual",
    profile: "strict",
    classification: sampleClassification(),
  };
  const r = canTransition(state, "COMPLETED", {
    review_level: "none",
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /illegal|dual|spec/i.test(e) || e.includes("dual")),
  );
});

test("ctx direct_eligible cannot grant DIRECT_IMPLEMENTING", () => {
  let state = createEmptyRunState("gate-2");
  state = transition(state, "CLASSIFIED", {
    classification: sampleClassification({
      direct_eligible: false,
      execution_mode: "delegated",
    }),
  }).state;
  const r = canTransition(state, "DIRECT_IMPLEMENTING", {
    direct_eligible: true,
  });
  assert.equal(r.ok, false);
});

test("HIGH blast escalates review_level to dual and profile to strict", () => {
  let state = createEmptyRunState("gate-3");
  state = transition(state, "CLASSIFIED", {
    classification: sampleClassification({
      profile: "balanced",
      review_level: "unified",
    }),
  }).state;
  state = transition(state, "PLANNED", { plan_skip: true }).state;
  state = transition(state, "GRAPH_READY", {
    graph: { ok: true, confidence: 0.9, path: "g.json" },
  }).state;
  const r = transition(state, "BLAST_READY", {
    blast: {
      risk: "HIGH",
      level: "HIGH",
      score: 20,
      uncertainties: [],
      dimensions: {},
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.review_level, "dual");
  assert.equal(r.state.profile, "strict");
  assert.ok(r.state.escalation_reasons.includes("blast_risk_high"));
});

test("escalate_to_dual APPROVED cannot COMPLETE unified", () => {
  const state = {
    ...createEmptyRunState("gate-4"),
    state: "REVIEWING",
    review_level: "unified",
    current_unit: "unit-1",
    implementer_commit: "abc123",
  };
  const r = canTransition(state, "COMPLETED", {
    unified_handoff: {
      schema_version: "1.0",
      verdict: "APPROVED",
      escalate_to_dual: true,
      run_id: "gate-4",
      unit_or_task: "unit-1",
      reviewed_commit: "abc123",
    },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /escalate_to_dual/i.test(e)));
});

test("public-api class alone → strict dual via reviewMatrix", () => {
  const cfg = loadWorkflowConfig();
  const r = classify(
    { filesChanged: 1, estimatedLines: 10, changeClass: "public-api" },
    { workflowConfig: cfg },
  );
  assert.equal(r.profile, "strict");
  assert.equal(r.review_level, "dual");
  assert.ok(r.hard_triggers.includes("public_api"));
});

test("IMPLEMENTING without drift is rejected", () => {
  const state = {
    ...createEmptyRunState("gate-5"),
    state: "BLAST_READY",
    blast: { risk: "LOW", uncertainties: [], dimensions: {} },
    branch: "feature/x",
  };
  const r = canTransition(state, "IMPLEMENTING", {
    branch: "feature/x",
    blast: state.blast,
    acceptance_criteria: ["works"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /DriftReport/i.test(e)));
});

test("empty drift object is not acceptable", () => {
  assert.equal(isPlanCommitAcceptable({}), false);
  assert.equal(isPlanCommitAcceptable(null), false);
});

test("VERIFYING rejects empty verification_gates", () => {
  const state = {
    ...createEmptyRunState("gate-6"),
    state: "IMPLEMENTING",
    review_level: "unified",
    execution_mode: "delegated",
    run_id: "gate-6",
    current_unit: "u1",
  };
  const r = canTransition(state, "VERIFYING", {
    implementer_handoff: {
      schema_version: "1.0",
      status: "DONE",
      run_id: "gate-6",
      unit_or_task: "u1",
      commit: "c1",
      verification_gates: [],
      drift_check: { pass: true },
      blast: { verified: true, risk: "LOW" },
    },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /verification gate/i.test(e)));
});

test("stale approval without run binding rejected", () => {
  const state = {
    ...createEmptyRunState("gate-7"),
    state: "REVIEWING",
    review_level: "unified",
    current_unit: "auth",
    implementer_commit: "deadbeef",
  };
  const r = canTransition(state, "COMPLETED", {
    unified_handoff: {
      schema_version: "1.0",
      verdict: "APPROVED",
      agent: "unified-reviewer",
    },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /run_id|binding/i.test(e)));
});

test("COMPLETED is terminal", () => {
  const state = { ...createEmptyRunState("gate-8"), state: "COMPLETED" };
  const r = canTransition(state, "BLOCKED", {
    reason: "nope",
    code: "X",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /terminal/i.test(e)));
});

test("run_id path traversal rejected", () => {
  assert.throws(() => assertValidRunId("../etc"), /invalid run_id/);
  assert.throws(() => assertValidRunId("a/b"), /invalid run_id/);
  assert.equal(assertValidRunId("run-2026-auth"), "run-2026-auth");
});

test("acceptance criteria version mismatch is HIGH drift", () => {
  const r = assessDrift({
    acceptance_criteria_version: "v1",
    expected_acceptance_criteria_version: "v2",
    commit_distance: 0,
  });
  assert.equal(r.drift, "HIGH");
});

test("legacy handoff marked legacy_unverified", () => {
  const { data } = normalizeHandoff("implementer", { status: "DONE" });
  assert.equal(data.legacy_unverified, true);
});

test("bound unified approval completes", () => {
  const state = {
    ...createEmptyRunState("gate-9"),
    state: "REVIEWING",
    review_level: "unified",
    current_unit: "auth",
    implementer_commit: "abc123",
  };
  const r = canTransition(state, "COMPLETED", {
    unified_handoff: {
      schema_version: "1.0",
      verdict: "APPROVED",
      run_id: "gate-9",
      unit_or_task: "auth",
      reviewed_commit: "abc123",
      escalate_to_dual: false,
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});
