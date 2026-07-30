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
import { canTransition, transition } from "../../scripts/lib/state-machine.js";
import { classify } from "../../scripts/lib/classify.js";

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
});

test("corrupt handoff blocks VERIFYING", () => {
  let state = createEmptyRunState("t3");
  state = transition(state, "CLASSIFIED", {
    classification: sampleClassification(),
  }).state;
  // Force skip to IMPLEMENTING path by mutating for test of VERIFYING only
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

test("direct path allowed when eligible and high confidence", () => {
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
  state = transition(state, "CLASSIFIED", { classification: c }).state;
  const r = transition(state, "DIRECT_IMPLEMENTING", {
    classification: c,
    graph: {
      ok: true,
      trusted: true,
      quality: "PRECISE",
      stale: false,
      freshness: { valid: true },
    },
    blast: {
      risk: "LOW",
      trusted: true,
      analysis_quality: "PRECISE",
      graph_quality: "PRECISE",
      graph_freshness: { valid: true },
      analysis_complete: true,
      uncertainties: [],
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.execution_mode, "direct");
});

test("direct path rejects a fresh conservative graph even when provider says ok", () => {
  const state = {
    ...createEmptyRunState("t5-conservative-graph"),
    state: "CLASSIFIED",
    execution_mode: "direct",
    classification: sampleClassification({
      execution_mode: "direct",
      direct_eligible: true,
      confidence: 0.95,
      evidence_source: "git-diff",
      diff_verified: true,
      diff_available: true,
      diff_clean: false,
    }),
    graph: {
      ok: true,
      trusted: false,
      quality: "CONSERVATIVE",
      stale: false,
      freshness: { valid: true },
    },
    blast: {
      risk: "LOW",
      trusted: true,
      analysis_quality: "PRECISE",
      graph_quality: "PRECISE",
      graph_freshness: { valid: true },
      analysis_complete: true,
    },
  };
  const result = canTransition(state, "DIRECT_IMPLEMENTING");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /trusted PRECISE graph/i);
});

test("direct path rejects a low-risk heuristic blast", () => {
  const state = {
    ...createEmptyRunState("t5-heuristic-blast"),
    state: "CLASSIFIED",
    execution_mode: "direct",
    classification: sampleClassification({
      execution_mode: "direct",
      direct_eligible: true,
      confidence: 0.95,
      evidence_source: "git-diff",
      diff_verified: true,
      diff_available: true,
      diff_clean: false,
    }),
    graph: {
      ok: true,
      trusted: true,
      quality: "PRECISE",
      stale: false,
    },
    blast: {
      risk: "LOW",
      analysis_quality: "lite-heuristic",
      analysis_complete: false,
      graph_freshness: { valid: true },
    },
  };
  const result = canTransition(state, "DIRECT_IMPLEMENTING");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /trusted LOW blast/i);
});

test("direct path rejects missing graph or blast evidence", () => {
  const state = {
    ...createEmptyRunState("t5-missing-analysis"),
    state: "CLASSIFIED",
    execution_mode: "direct",
    classification: sampleClassification({
      execution_mode: "direct",
      direct_eligible: true,
      confidence: 0.95,
      evidence_source: "git-diff",
      diff_verified: true,
      diff_available: true,
      diff_clean: false,
    }),
  };
  const result = canTransition(state, "DIRECT_IMPLEMENTING");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /trusted LOW blast/i);
  assert.match(result.errors.join("\n"), /trusted PRECISE graph/i);
});

test("delegated low-risk transition remains allowed with conservative analysis", () => {
  let state = createEmptyRunState("t5-delegated-conservative");
  state = transition(state, "CLASSIFIED", {
    classification: sampleClassification(),
  }).state;
  state = transition(state, "PLANNED", { plan_skip: true }).state;
  state = transition(state, "GRAPH_READY", {
    graph: {
      ok: true,
      trusted: false,
      quality: "CONSERVATIVE",
      stale: false,
    },
  }).state;
  state = transition(state, "BLAST_READY", {
    blast: { risk: "LOW", uncertainties: [], dimensions: {} },
  }).state;
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
    current_unit: "unit-a",
    implementer_commit: "abc123",
  };
  const bad = canTransition(state, "COMPLETED", {
    unified_handoff: { schema_version: "1.0", verdict: "REQUEST_CHANGES" },
  });
  assert.equal(bad.ok, false);

  const unbound = canTransition(state, "COMPLETED", {
    unified_handoff: {
      schema_version: "1.0",
      verdict: "APPROVED",
      agent: "unified-reviewer",
    },
  });
  assert.equal(unbound.ok, false);

  const good = canTransition(state, "COMPLETED", {
    unified_handoff: {
      schema_version: "1.0",
      verdict: "APPROVED",
      agent: "unified-reviewer",
      run_id: "t6",
      unit_or_task: "unit-a",
      reviewed_commit: "abc123",
    },
  });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
});

test("full delegated happy path through BLAST_READY", () => {
  let state = createEmptyRunState("happy");
  const classification = sampleClassification();
  state = transition(state, "CLASSIFIED", { classification }).state;
  state = transition(state, "PLANNED", { plan_skip: true }).state;
  state = transition(state, "GRAPH_READY", {
    graph: { ok: true, confidence: 0.9, path: "graph.json" },
  }).state;
  state = transition(state, "BLAST_READY", {
    blast: { risk: "LOW", uncertainties: [], dimensions: {}, score: 1 },
  }).state;
  assert.equal(state.state, "BLAST_READY");

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

test("unknown blast cannot pass BLAST_READY without persisted verification", () => {
  let state = createEmptyRunState("unknown-blast");
  state = transition(state, "CLASSIFIED", {
    classification: sampleClassification(),
  }).state;
  state = transition(state, "PLANNED", { plan_skip: true }).state;
  state = transition(state, "GRAPH_READY", {
    graph: { ok: true, confidence: 0.9, path: "g.json" },
  }).state;

  const blast = {
    risk: "UNKNOWN",
    level: "UNKNOWN",
    analysis_quality: "CONSERVATIVE",
    uncertainties: ["graph is stale"],
    score: 0,
  };
  const denied = transition(state, "BLAST_READY", { blast });
  assert.equal(denied.ok, false);
  assert.match(denied.errors.join("\n"), /blast_verification/i);

  const verified = transition(state, "BLAST_READY", {
    blast,
    blast_verification: {
      verified: true,
      method: "human-review",
      reason: "reviewed affected callers manually",
    },
  });
  assert.equal(verified.ok, true, JSON.stringify(verified.errors));
  assert.deepEqual(verified.state.blast_verification, {
    verified: true,
    method: "human-review",
    reason: "reviewed affected callers manually",
  });

  const implementingEvidence = {
    branch: "feature/unknown-blast",
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
    blast_verification: null,
  };
  const implementingDenied = canTransition(
    withoutPersistedVerification,
    "IMPLEMENTING",
    implementingEvidence,
  );
  assert.equal(implementingDenied.ok, false);
  assert.match(implementingDenied.errors.join("\n"), /persisted blast_verification/i);

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
    classification: {
      ...sampleClassification({
        execution_mode: "direct",
        direct_eligible: true,
        confidence: 0.95,
        evidence_source: "git-diff",
        diff_verified: true,
        diff_available: true,
        diff_clean: false,
      }),
    },
    blast: { risk: "UNKNOWN", level: "UNKNOWN", uncertainties: [] },
  };
  const r = canTransition(state, "DIRECT_IMPLEMENTING", {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /trusted LOW blast/i);
});
