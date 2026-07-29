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
  });
  assert.equal(c.direct_eligible, true);
  let state = createEmptyRunState("t5");
  state = transition(state, "CLASSIFIED", { classification: c }).state;
  const r = transition(state, "DIRECT_IMPLEMENTING", { classification: c });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.execution_mode, "direct");
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

test("REVIEWING → COMPLETED needs APPROVED unified", () => {
  const state = {
    ...createEmptyRunState("t6"),
    state: "REVIEWING",
    review_level: "unified",
  };
  const bad = canTransition(state, "COMPLETED", {
    unified_handoff: { verdict: "REQUEST_CHANGES" },
  });
  assert.equal(bad.ok, false);

  const good = canTransition(state, "COMPLETED", {
    unified_handoff: { verdict: "APPROVED", agent: "unified-reviewer" },
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
    drift: { drift: "NONE", reasons: [], schema_version: "1.0" },
  });
  assert.equal(toImpl.ok, true, JSON.stringify(toImpl.errors));
});
