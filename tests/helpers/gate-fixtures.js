/**
 * Shared helpers for gate-integrity tests (schema 1.1 + sealed artifacts).
 */
import {
  sealGraphArtifact,
  sealBlastArtifact,
  CLASSIFY_APPLY_SOURCE,
} from "../../scripts/lib/state-machine.js";

export function handoffEnvelope(overrides = {}) {
  return {
    schema_version: "1.1",
    run_id: "test-run",
    unit_or_task: "unit-1",
    agent: "implementer",
    base_commit: "base111",
    created_at: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

export function goodImplementerHandoff(overrides = {}) {
  return {
    ...handoffEnvelope({ agent: "implementer" }),
    status: "DONE",
    commit: "impl222",
    files_changed: [],
    tests: [],
    verification_gates: [{ id: "unit", cmd: "npm test", pass: true }],
    drift_check: {
      plan_commit: "base111",
      current_head: "impl222",
      pass: true,
    },
    blast: { risk: "LOW", verified: true, callers_checked: [] },
    notes_for_reviewer: "",
    ...overrides,
  };
}

export function goodUnifiedHandoff(overrides = {}) {
  return {
    ...handoffEnvelope({ agent: "unified-reviewer" }),
    verdict: "APPROVED",
    reviewed_commit: "impl222",
    blast: { pass: true, risk: "LOW" },
    ...overrides,
  };
}

export function sealedPreciseGraph(overrides = {}) {
  return sealGraphArtifact({
    ok: true,
    trusted: true,
    quality: "PRECISE",
    stale: false,
    fresh: true,
    freshness: { valid: true },
    confidence: 0.75,
    graph_provider: "graphify",
    graph_path: "/tmp/graphify-out/graph.json",
    graphify_out: "/tmp/graphify-out",
    path: "/tmp/graphify-out/graph.json",
    ...overrides,
  });
}

export function sealedLowBlast(overrides = {}) {
  return sealBlastArtifact({
    risk: "LOW",
    trusted: true,
    analysis_quality: "PRECISE",
    graph_quality: "PRECISE",
    graph_provider: "graphify",
    graph_path: "/tmp/graphify-out/graph.json",
    graph_freshness: { valid: true },
    analysis_complete: true,
    uncertainties: [],
    dimensions: {},
    ...overrides,
  });
}

export function mockTrustProviders({ graph, blast } = {}) {
  const g = graph || sealedPreciseGraph();
  const b = blast || sealedLowBlast();
  return {
    graphProvider: {
      build() {
        return {
          ...g,
          provider_validated: undefined,
          artifact_digest: undefined,
        };
      },
    },
    blastProvider: {
      analyze() {
        return {
          ok: true,
          report: {
            ...b,
            provider_validated: undefined,
            artifact_digest: undefined,
          },
        };
      },
    },
    telemetry: { emit() {} },
    memory: {
      retrieve() {
        return { entries: [] };
      },
    },
    editValidator: {
      validate() {
        return { ok: true };
      },
    },
  };
}

export { CLASSIFY_APPLY_SOURCE };
