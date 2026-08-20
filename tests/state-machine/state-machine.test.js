import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createEmptyRunState,
  writeRunState,
  readRunState,
} from "../../scripts/lib/migrate-artifacts.js";
import {
  canTransition,
  transition,
  CLASSIFY_APPLY_SOURCE,
} from "../../scripts/lib/state-machine.js";
import { classify } from "../../scripts/lib/classify.js";
import {
  goodImplementerHandoff,
  goodUnifiedHandoff,
  mockTrustProviders,
  sealedPreciseGraph,
  sealedLowBlast,
  sealedImpact,
  sealedVerification,
} from "../helpers/gate-fixtures.js";

function sampleClassification(overrides = {}) {
  return {
    schema_version: "1.0",
    profile: "balanced",
    review_level: "unified",
    execution_mode: "delegated",
    risk_score: 2,
    confidence: 0.8,
    reasons: ["test"],
    direct_eligible: false,
    change_class: "small-feature-with-tests",
    hard_triggers: [],
    ...overrides,
  };
}

function providersFor(reportOverrides = {}) {
  return mockTrustProviders({
    blast: sealedLowBlast(reportOverrides),
  });
}

test("illegal transition CREATED → IMPLEMENTING rejected", () => {
  const state = createEmptyRunState("t1");
  const r = canTransition(state, "IMPLEMENTING", {});
  assert.equal(r.ok, false);
});

test("CREATED → CLASSIFIED with valid evidence", () => {
  const state = createEmptyRunState("t2");
  const classification = sampleClassification();
  const r = transition(state, "CLASSIFIED", { classification });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.state, "CLASSIFIED");
  assert.equal(r.state.profile, "balanced");
  assert.equal(r.state.classification.direct_eligible, false);
  assert.equal(r.state.classification_source, "transition-untrusted");
});

test("corrupt handoff blocks VERIFYING", () => {
  let state = createEmptyRunState("t3");
  state = transition(state, "CLASSIFIED", {
    classification: sampleClassification(),
  }).state;
  state.state = "IMPLEMENTING";
  const r = canTransition(state, "VERIFYING", {
    implementer_handoff: { schema_version: "1.0", status: "NOPE" },
  });
  assert.equal(r.ok, false);
});

test("direct path rejected when not eligible", () => {
  let state = createEmptyRunState("t4");
  state = transition(state, "CLASSIFIED", {
    classification: sampleClassification({
      direct_eligible: false,
      confidence: 0.9,
    }),
  }).state;
  const r = canTransition(state, "DIRECT_IMPLEMENTING", {});
  assert.equal(r.ok, false);
});

test("direct path allowed when eligible via classify --apply and sealed analysis", () => {
  const c = classify({
    filesChanged: 1,
    estimatedLines: 10,
    changeClass: "documentation",
    documentationOnly: true,
    focusedValidation: true,
    evidence_source: "git-diff",
    diff_verified: true,
    diff_available: true,
    diff_clean: false,
  });
  assert.equal(c.direct_eligible, true);
  let state = createEmptyRunState("t5");
  state = transition(
    state,
    "CLASSIFIED",
    { classification: c, classification_source: CLASSIFY_APPLY_SOURCE },
    providersFor(),
  ).state;
  assert.equal(state.classification_source, CLASSIFY_APPLY_SOURCE);
  const r = transition(state, "DIRECT_IMPLEMENTING", {}, mockTrustProviders());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.execution_mode, "direct");
});

test("transition classification cannot authorize direct_eligible", () => {
  const c = classify({
    filesChanged: 1,
    estimatedLines: 10,
    changeClass: "documentation",
    documentationOnly: true,
    focusedValidation: true,
    evidence_source: "git-diff",
    diff_verified: true,
    diff_available: true,
    diff_clean: false,
  });
  let state = createEmptyRunState("t5-strip");
  state = transition(state, "CLASSIFIED", { classification: c }).state;
  assert.equal(state.classification.direct_eligible, false);
  const r = transition(state, "DIRECT_IMPLEMENTING", {}, mockTrustProviders());
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /classify --apply/i);
});

test("direct path rejects a conservative impact even when labeled LOW", () => {
  const state = {
    ...createEmptyRunState("t5-conservative-graph"),
    state: "CLASSIFIED",
    execution_mode: "direct",
    classification_source: CLASSIFY_APPLY_SOURCE,
    classification: sampleClassification({
      execution_mode: "direct",
      direct_eligible: true,
      confidence: 0.95,
      evidence_source: "git-diff",
      diff_verified: true,
      diff_available: true,
      diff_clean: false,
      classification_source: CLASSIFY_APPLY_SOURCE,
    }),
    impact: sealedImpact({
      trusted: false,
      analysis_quality: "CONSERVATIVE",
      graph_quality: "CONSERVATIVE",
      confidence: 0.6,
    }),
    blast: sealedImpact({
      trusted: false,
      analysis_quality: "CONSERVATIVE",
      graph_quality: "CONSERVATIVE",
      confidence: 0.6,
    }),
  };
  const result = canTransition(state, "DIRECT_IMPLEMENTING");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /LOW impact/i);
});

test("direct path rejects a low-risk heuristic blast", () => {
  const state = {
    ...createEmptyRunState("t5-heuristic-blast"),
    state: "CLASSIFIED",
    execution_mode: "direct",
    classification_source: CLASSIFY_APPLY_SOURCE,
    classification: sampleClassification({
      execution_mode: "direct",
      direct_eligible: true,
      confidence: 0.95,
      evidence_source: "git-diff",
      diff_verified: true,
      diff_available: true,
      diff_clean: false,
      classification_source: CLASSIFY_APPLY_SOURCE,
    }),
    impact: sealedImpact({
      analysis_quality: "lite-heuristic",
      analysis_complete: false,
      trusted: false,
      confidence: 0.5,
    }),
    blast: sealedImpact({
      analysis_quality: "lite-heuristic",
      analysis_complete: false,
      trusted: false,
      confidence: 0.5,
    }),
  };
  const result = canTransition(state, "DIRECT_IMPLEMENTING");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /LOW (blast|impact)/i);
});

test("direct path rejects missing impact evidence", () => {
  const state = {
    ...createEmptyRunState("t5-missing-analysis"),
    state: "CLASSIFIED",
    execution_mode: "direct",
    classification_source: CLASSIFY_APPLY_SOURCE,
    classification: sampleClassification({
      execution_mode: "direct",
      direct_eligible: true,
      confidence: 0.95,
      evidence_source: "git-diff",
      diff_verified: true,
      diff_available: true,
      diff_clean: false,
      classification_source: CLASSIFY_APPLY_SOURCE,
    }),
  };
  const result = canTransition(state, "DIRECT_IMPLEMENTING");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /LOW (blast|impact)/i);
});

test("fabricated trusted graph labels are rejected", () => {
  let state = createEmptyRunState("fabricated-graph");
  state = transition(state, "CLASSIFIED", {
    classification: sampleClassification(),
  }).state;
  state = transition(state, "PLANNED", { plan_skip: true }).state;
  const r = canTransition(state, "IMPACT_READY", {
    graph: { ok: true, trusted: true, quality: "PRECISE", confidence: 0.9 },
  });
  assert.equal(r.ok, false);
  assert.match(
    r.errors.join("\n"),
    /impact|unsealed|provider revalidation|IMPACT_READY/i,
  );
});

test("delegated low-risk transition remains allowed with conservative analysis", () => {
  const providers = mockTrustProviders({
    graph: sealedPreciseGraph({
      trusted: false,
      quality: "CONSERVATIVE",
    }),
    blast: sealedLowBlast({ trusted: false, analysis_quality: "CONSERVATIVE" }),
  });
  // Force mock build to return conservative
  providers.graphProvider.build = () => ({
    ok: true,
    trusted: false,
    quality: "CONSERVATIVE",
    stale: false,
    confidence: 0.5,
    path: "g.json",
  });
  providers.blastProvider.analyze = () => ({
    ok: true,
    report: {
      risk: "LOW",
      uncertainties: [],
      dimensions: {},
      trusted: false,
      analysis_quality: "CONSERVATIVE",
    },
  });

  let state = createEmptyRunState("t5-delegated-conservative");
  state = transition(state, "CLASSIFIED", {
    classification: sampleClassification(),
  }).state;
  state = transition(state, "PLANNED", { plan_skip: true }).state;
  state = transition(state, "IMPACT_READY", {}, providers).state;
  state = transition(
    state,
    "IMPACT_READY",
    {
      blast_verification: { verified: true, method: "test" },
    },
    providers,
  ).state;
  const result = canTransition(state, "IMPLEMENTING", {
    branch: "feature/conservative",
    blast: state.blast,
    acceptance_criteria: ["works"],
    drift: {
      schema_version: "1.0",
      drift: "NONE",
      reasons: [],
      commit_distance: 0,
      plan_commit: "plan",
      current_head: "head",
      anchors_broken: [],
      merge_base_changed: false,
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("resume does not rewind COMPLETED", () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sm-"));
  let state = createEmptyRunState("done-run");
  state.state = "COMPLETED";
  state.review_level = "none";
  writeRunState(wt, state);
  const loaded = readRunState(wt, "done-run");
  assert.equal(loaded.state, "COMPLETED");
  const back = canTransition(loaded, "IMPLEMENTING", {});
  assert.equal(back.ok, false);
});

test("REVIEWING → COMPLETED needs APPROVED unified bound to run", () => {
  const state = {
    ...createEmptyRunState("t6"),
    state: "REVIEWING",
    review_level: "unified",
    compatibility_mode: "v3",
    current_unit: "unit-a",
    implementer_commit: "abc123",
    head_commit: "base000",
  };
  const bad = canTransition(state, "COMPLETED", { legacy_skip_final: true,
    unified_handoff: goodUnifiedHandoff({
      run_id: "t6",
      unit_or_task: "unit-a",
      verdict: "REQUEST_CHANGES",
      reviewed_commit: "abc123",
      base_commit: "base000",
    }),
  });
  assert.equal(bad.ok, false);

  const unbound = canTransition(state, "COMPLETED", { legacy_skip_final: true,
    unified_handoff: goodUnifiedHandoff({
      run_id: undefined,
      unit_or_task: "unit-a",
      reviewed_commit: "abc123",
      base_commit: "base000",
    }),
  });
  assert.equal(unbound.ok, false);

  const good = canTransition(state, "COMPLETED", { legacy_skip_final: true,
    unified_handoff: goodUnifiedHandoff({
      run_id: "t6",
      unit_or_task: "unit-a",
      reviewed_commit: "abc123",
      base_commit: "base000",
    }),
  });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
});

test("full delegated happy path through IMPACT_READY", () => {
  const providers = providersFor();
  let state = createEmptyRunState("happy");
  const classification = sampleClassification();
  state = transition(state, "CLASSIFIED", { classification }).state;
  state = transition(state, "PLANNED", { plan_skip: true }).state;
  state = transition(state, "IMPACT_READY", {}, providers).state;
  assert.equal(state.state, "IMPACT_READY");

  const toImpl = canTransition(state, "IMPLEMENTING", {
    branch: "feature/x",
    blast: state.blast,
    acceptance_criteria: ["works"],
    drift: {
      schema_version: "1.0",
      drift: "NONE",
      reasons: [],
      commit_distance: 0,
      plan_commit: "abc",
      current_head: "def",
      anchors_broken: [],
      merge_base_changed: false,
    },
  });
  assert.equal(toImpl.ok, true, JSON.stringify(toImpl.errors));
});

test("unknown impact cannot pass IMPACT_READY without persisted verification", () => {
  const unknownReport = {
    schema_version: "1.0",
    risk: "UNKNOWN",
    level: "UNKNOWN",
    confidence: 0.4,
    analysis_quality: "CONSERVATIVE",
    graph_quality: "CONSERVATIVE",
    uncertainties: ["coverage incomplete"],
    score: 0,
  };
  const providers = {
    ...mockTrustProviders(),
    impactProvider: {
      analyze() {
        return { ok: true, report: unknownReport };
      },
    },
    blastProvider: {
      analyze() {
        return { ok: true, report: unknownReport };
      },
    },
  };
  let state = createEmptyRunState("unknown-blast");
  state = transition(state, "CLASSIFIED", {
    classification: sampleClassification(),
  }).state;
  state = transition(state, "PLANNED", { plan_skip: true }).state;

  const denied = transition(state, "IMPACT_READY", {}, providers);
  assert.equal(denied.ok, false);
  assert.match(denied.errors.join("\n"), /impact_verification|blast_verification/i);

  const verified = transition(
    state,
    "IMPACT_READY",
    {
      impact_verification: {
        verified: true,
        method: "human-review",
        reason: "reviewed affected callers manually",
      },
    },
    providers,
  );
  assert.equal(verified.ok, true, JSON.stringify(verified.errors));

  const implementingEvidence = {
    branch: "feature/unknown-blast",
    impact: verified.state.impact || verified.state.blast,
    blast: verified.state.blast,
    acceptance_criteria: ["verification is explicit"],
    drift: {
      schema_version: "1.0",
      drift: "NONE",
      reasons: [],
      commit_distance: 0,
      plan_commit: "plan",
      current_head: "head",
      anchors_broken: [],
      merge_base_changed: false,
    },
  };
  const withoutPersistedVerification = {
    ...verified.state,
    impact_verification: null,
    blast_verification: null,
  };
  const implementingDenied = canTransition(
    withoutPersistedVerification,
    "IMPLEMENTING",
    implementingEvidence,
  );
  assert.equal(implementingDenied.ok, false);
  assert.match(implementingDenied.errors.join("\n"), /persisted (blast|impact)_verification/i);

  const implementingAllowed = canTransition(
    verified.state,
    "IMPLEMENTING",
    implementingEvidence,
  );
  assert.equal(implementingAllowed.ok, true, JSON.stringify(implementingAllowed.errors));
});

test("direct transition cannot bypass an unverified unknown blast", () => {
  const state = {
    ...createEmptyRunState("direct-unknown"),
    state: "CLASSIFIED",
    execution_mode: "direct",
    classification_source: CLASSIFY_APPLY_SOURCE,
    classification: {
      ...sampleClassification({
        execution_mode: "direct",
        direct_eligible: true,
        confidence: 0.95,
        evidence_source: "git-diff",
        diff_verified: true,
        diff_available: true,
        diff_clean: false,
        classification_source: CLASSIFY_APPLY_SOURCE,
      }),
    },
    blast: { risk: "UNKNOWN", level: "UNKNOWN", uncertainties: [] },
  };
  const r = canTransition(state, "DIRECT_IMPLEMENTING", {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /LOW (blast|impact)/i);
});

test("implementer commit binding uses base_commit vs new commit", () => {
  const state = {
    ...createEmptyRunState("bind-impl"),
    state: "IMPLEMENTING",
    head_commit: "base111",
    current_unit: "unit-1",
    review_level: "unified",
    execution_mode: "delegated",
  };
  const providers = mockTrustProviders();
  const r = canTransition(state, "VERIFYING", {
    provider_verification: sealedVerification(),
    post_impact: sealedImpact({ phase: "post" }),
    implementer_handoff: goodImplementerHandoff({
      run_id: "bind-impl",
      unit_or_task: "unit-1",
      base_commit: "base111",
      commit: "impl222",
    }),
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const applied = transition(
    state,
    "VERIFYING",
    {
      implementer_handoff: goodImplementerHandoff({
        run_id: "bind-impl",
        unit_or_task: "unit-1",
        base_commit: "base111",
        commit: "impl222",
      }),
    },
    providers,
  );
  assert.equal(applied.ok, true, JSON.stringify(applied.errors));
  assert.equal(applied.state.implementer_commit, "impl222");
  assert.equal(applied.state.head_commit, "base111");
  assert.equal(applied.state.provider_verification?.ok, true);
});

test("reviewer binds to implementer_commit not head_commit", () => {
  const state = {
    ...createEmptyRunState("bind-rev"),
    state: "REVIEWING",
    review_level: "unified",
    compatibility_mode: "v3",
    current_unit: "unit-1",
    head_commit: "base111",
    implementer_commit: "impl222",
  };
  const wrong = canTransition(state, "COMPLETED", { legacy_skip_final: true,
    unified_handoff: goodUnifiedHandoff({
      run_id: "bind-rev",
      unit_or_task: "unit-1",
      base_commit: "base111",
      reviewed_commit: "base111",
    }),
  });
  assert.equal(wrong.ok, false);

  const good = canTransition(state, "COMPLETED", { legacy_skip_final: true,
    unified_handoff: goodUnifiedHandoff({
      run_id: "bind-rev",
      unit_or_task: "unit-1",
      base_commit: "base111",
      reviewed_commit: "impl222",
    }),
  });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
});

test("implementer cannot self-exempt verification", () => {
  const state = {
    ...createEmptyRunState("no-exempt"),
    state: "IMPLEMENTING",
    head_commit: "base111",
    current_unit: "unit-1",
    review_level: "unified",
    execution_mode: "delegated",
    verification_policy: { exempt: false, reason: null },
  };
  const r = canTransition(state, "VERIFYING", {
    implementer_handoff: {
      ...goodImplementerHandoff({
        run_id: "no-exempt",
        unit_or_task: "unit-1",
        verification_gates: [],
        drift_check: { pass: true },
      }),
      verification_exempt: true,
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /provider|verification/i);
});
