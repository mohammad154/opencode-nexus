/**
 * Structured review findings + fix-loop policy.
 */
export function normalizeFinding(finding = {}) {
  return {
    id: finding.id || `F-${Math.random().toString(36).slice(2, 8)}`,
    severity: String(finding.severity || "MEDIUM").toUpperCase(),
    title: finding.title || finding.summary || "finding",
    evidence: finding.evidence || finding.detail || "",
    commit: finding.commit || finding.reviewed_commit || null,
    resolved: finding.resolved === true,
  };
}

export function unresolvedHighFindings(findings = []) {
  return findings
    .map(normalizeFinding)
    .filter((f) => !f.resolved && (f.severity === "HIGH" || f.severity === "CRITICAL"));
}

export function canSelfApprove({ author_agent, reviewer_agent } = {}) {
  if (!author_agent || !reviewer_agent) return false;
  return author_agent === reviewer_agent;
}

export function fixLoopDecision({
  findings = [],
  attempt = 0,
  max_attempts = 3,
} = {}) {
  const openHigh = unresolvedHighFindings(findings);
  if (openHigh.length === 0) {
    return { action: "continue", open_high: [] };
  }
  if (attempt >= max_attempts) {
    return {
      action: "block",
      reason: "fix loop exhausted with unresolved HIGH findings",
      open_high: openHigh,
    };
  }
  return {
    action: "redispatch_implementer",
    attempt: attempt + 1,
    open_high: openHigh,
  };
}
