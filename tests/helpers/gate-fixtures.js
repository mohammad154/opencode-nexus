/**
 * Shared helpers for gate-integrity tests (schema 1.1 + sealed artifacts) — V5.
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
    files_changed: ["src/app.js"],
    allowed_files: ["src/app.js"],
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

export function goodReviewerHandoff(overrides = {}) {
  return {
    ...handoffEnvelope({ agent: "reviewer" }),
    verdict: "APPROVED",
    reviewed_commit: "impl222",
    impact: { pass: true, risk: "LOW" },
    findings: [],
    acceptance: [],
    ...overrides,
  };
}

/** @deprecated Use goodReviewerHandoff */
export function goodUnifiedHandoff(overrides = {}) {
  return goodReviewerHandoff(overrides);
}

export function goodIntegrationHandoff(overrides = {}) {
  return goodReviewerHandoff(overrides);
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
    changed_files: ["src/app.js"],
    planned_targets: ["src/app.js"],
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
    implementer_handoff: goodImplementerHandoff(),
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
    ...overrides,
  });
}

export function sealedLowBlast(overrides = {}) {
  return sealedImpact(overrides);
}

export function mockTrustProviders(opts = {}) {
  const impact = opts.blast || opts.impact || sealedImpact();
  return {
    impactProvider: {
      analyze() {
        return { ok: true, report: impact };
      },
    },
    blastProvider: {
      analyze() {
        return { ok: true, report: impact };
      },
    },
    verificationProvider: {
      discover() {
        return { steps: [{ id: "noop", command: "true" }] };
      },
      run() {
        return {
          ok: true,
          results: [{ id: "noop", command: "true", exit_code: 0, pass: true }],
        };
      },
      compare() {
        return { ok: true, new_regressions: [] };
      },
      verifyTdd() {
        return sealImpactArtifact({
          ok: true,
          red: { exit_code: 1, command: "npm test" },
          green: { exit_code: 0, command: "npm test" },
        });
      },
    },
    telemetry: { emit() {} },
    ...(opts.extra || {}),
  };
}

export { CLASSIFY_APPLY_SOURCE, sealImpactArtifact, sealBlastArtifact };
