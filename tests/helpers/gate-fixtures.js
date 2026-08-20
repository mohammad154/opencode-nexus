/**
 * Shared helpers for gate-integrity tests (schema 1.1 + sealed artifacts).
 */
import {
  sealImpactArtifact,
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
    impact: { risk: "LOW", verified: true, callers_checked: [] },
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
    impact: { pass: true, risk: "LOW" },
    blast: { pass: true, risk: "LOW" },
    ...overrides,
  };
}

export function goodIntegrationHandoff(overrides = {}) {
  return {
    ...handoffEnvelope({ agent: "integration-reviewer" }),
    verdict: "APPROVED",
    reviewed_commit: "impl222",
    findings: [],
    ...overrides,
  };
}

export function sealedImpact(overrides = {}) {
  return sealImpactArtifact({
    schema_version: "1.0",
    ok: true,
    provider: "nexus-impact",
    graph_provider: "nexus-impact",
    risk: "LOW",
    level: "LOW",
    confidence: 0.95,
    trusted: true,
    analysis_quality: "PRECISE",
    graph_quality: "PRECISE",
    analysis_complete: true,
    graph_freshness: { valid: true },
    uncertainties: [],
    dimensions: {},
    changed_files: [],
    changed_symbols: [],
    direct_dependents: [],
    related_tests: [],
    ...overrides,
  });
}

export function sealedVerification(overrides = {}) {
  return sealImpactArtifact({
    ok: true,
    source: "verification-provider",
    results: [{ id: "noop", command: "true", exit_code: 0, pass: true }],
    ...overrides,
  });
}

export function verifyingEvidence(overrides = {}) {
  return {
    provider_verification: sealedVerification(),
    post_impact: sealedImpact({ phase: "post", pre_impact: false }),
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
    confidence: 0.95,
    graph_provider: "nexus-impact",
    graph_path: "/tmp/impact/latest.json",
    ...overrides,
  });
}

export function sealedLowBlast(overrides = {}) {
  return sealedImpact(overrides);
}

export function mockTrustProviders({ impact, graph, blast } = {}) {
  const i = impact || blast || sealedImpact();
  const g = graph || sealedPreciseGraph();
  return {
    impactProvider: {
      analyze(ctx = {}) {
        const report = {
          ...i,
          provider_validated: undefined,
          artifact_digest: undefined,
          phase: ctx.phase || ctx.post_impact ? "post" : i.phase || "pre",
          related_tests: i.related_tests || [],
        };
        return { ok: true, report };
      },
    },
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
            ...i,
            provider_validated: undefined,
            artifact_digest: undefined,
          },
        };
      },
    },
    verificationProvider: {
      discover() {
        return {
          ecosystem: "node",
          steps: [{ id: "noop", command: "true", kind: "generic" }],
        };
      },
      run() {
        return {
          ok: true,
          results: [{ id: "noop", command: "true", exit_code: 0, pass: true }],
          plan: { ecosystem: "node", steps: [] },
        };
      },
    },
    telemetry: { emit() {} },
    memory: {
      retrieve() {
        return { entries: [] };
      },
      record() {
        return { ok: true };
      },
    },
    editValidator: {
      validate() {
        return { ok: true };
      },
    },
  };
}

export { CLASSIFY_APPLY_SOURCE, sealImpactArtifact, sealBlastArtifact };
