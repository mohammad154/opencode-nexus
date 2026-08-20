/**
 * Scope lock helpers — out-of-scope edits require re-impact.
 */
import { scopeExpansionNeeded, normalizeAllowedFiles } from "./impact/boundaries.js";

export function assertScopeLock({ allowed_files = [], changed_files = [] } = {}) {
  const allowed = normalizeAllowedFiles(allowed_files);
  const check = scopeExpansionNeeded(allowed, changed_files);
  if (!check.needed) {
    return { ok: true, allowed_files: allowed };
  }
  return {
    ok: false,
    code: "SCOPE_EXPANSION_REQUIRED",
    extras: check.extras,
    message:
      "Implementer attempted out-of-scope edits; STOP, request scope expansion, rerun impact",
  };
}

export function buildFreshImplementerContext({
  task,
  acceptance_criteria = [],
  allowed_files = [],
  impact = null,
  baseline = null,
  verification_commands = [],
} = {}) {
  return {
    task,
    acceptance_criteria,
    allowed_files: normalizeAllowedFiles(allowed_files),
    impact_summary: impact
      ? {
          risk: impact.risk,
          confidence: impact.confidence,
          changed_files: impact.changed_files,
          related_tests: impact.related_tests,
        }
      : null,
    baseline,
    verification_commands,
  };
}
