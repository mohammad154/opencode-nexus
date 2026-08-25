/**
 * Structured review findings + fix-loop policy + approval admissibility.
 *
 * Nexus — not the LLM — decides whether an APPROVED verdict is gate-valid.
 */

export const MANDATORY_CHECK_CATEGORIES = [
  "correctness",
  "test_quality",
  "impact",
];

export function normalizeFinding(finding = {}) {
  const severity = String(finding.severity || "MEDIUM").toUpperCase();
  return {
    id: finding.id || `F-${Math.random().toString(36).slice(2, 8)}`,
    severity,
    title: finding.title || finding.summary || "finding",
    evidence: finding.evidence || finding.detail || "",
    commit: finding.commit || finding.reviewed_commit || null,
    resolved: finding.resolved === true,
    blocking:
      finding.blocking === true
        ? true
        : finding.blocking === false
          ? false
          : severity === "HIGH" || severity === "CRITICAL",
  };
}

/** Severity describes impact; blocking describes whether the workflow must stop. */
export function isBlockingFinding(finding = {}) {
  const n = normalizeFinding(finding);
  return !n.resolved && n.blocking === true;
}

export function unresolvedHighFindings(findings = []) {
  return findings.map(normalizeFinding).filter(isBlockingFinding);
}

export function canSelfApprove({ author_agent, reviewer_agent } = {}) {
  if (!author_agent || !reviewer_agent) return false;
  return author_agent === reviewer_agent;
}

function hasAcceptanceEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return false;
  return evidence.every(
    (e) =>
      e &&
      typeof e.file === "string" &&
      e.file.trim().length > 0 &&
      typeof e.reason === "string" &&
      e.reason.trim().length > 0,
  );
}

/**
 * Gate-level check: an APPROVED string alone is never sufficient.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function isApprovalAdmissible(handoff, state = {}) {
  const errors = [];
  if (!handoff || typeof handoff !== "object") {
    return { ok: false, errors: ["APPROVED requires a reviewer handoff"] };
  }
  if (handoff.verdict !== "APPROVED") {
    return {
      ok: false,
      errors: [`approval admissibility requires APPROVED, got ${handoff.verdict}`],
    };
  }

  const acceptance = Array.isArray(handoff.acceptance) ? handoff.acceptance : [];
  const expected = state.acceptance_criteria;
  const minAcceptance =
    Array.isArray(expected) && expected.length > 0 ? expected.length : 1;
  if (acceptance.length < minAcceptance) {
    errors.push(
      `APPROVED requires at least ${minAcceptance} evidence-backed acceptance entr${minAcceptance === 1 ? "y" : "ies"} (got ${acceptance.length})`,
    );
  }
  for (let i = 0; i < acceptance.length; i++) {
    const ac = acceptance[i] || {};
    if (ac.status !== "PASS") {
      errors.push(
        `acceptance[${i}] (${ac.id || "unknown"}) must be PASS for APPROVED (got ${ac.status})`,
      );
    }
    if (!hasAcceptanceEvidence(ac.evidence)) {
      errors.push(
        `acceptance[${i}] (${ac.id || "unknown"}) requires non-empty file/reason evidence`,
      );
    }
  }

  const files = Array.isArray(handoff.files_reviewed)
    ? handoff.files_reviewed.filter((f) => typeof f === "string" && f.trim())
    : [];
  if (files.length === 0) {
    errors.push("APPROVED requires non-empty files_reviewed");
  }

  const checks = Array.isArray(handoff.checks) ? handoff.checks : [];
  for (const cat of MANDATORY_CHECK_CATEGORIES) {
    const c = checks.find((x) => x && x.category === cat);
    if (!c) {
      errors.push(`APPROVED requires check category "${cat}" with evidence`);
      continue;
    }
    if (c.status !== "PASS") {
      errors.push(`check "${cat}" must be PASS for APPROVED (got ${c.status})`);
    }
    if (typeof c.evidence !== "string" || !c.evidence.trim()) {
      errors.push(`check "${cat}" requires non-empty evidence`);
    }
  }

  const findings = Array.isArray(handoff.findings) ? handoff.findings : [];
  const blocking = findings.filter(isBlockingFinding);
  if (blocking.length > 0) {
    errors.push(
      `APPROVED blocked by unresolved findings: ${blocking.map((f) => f.id || f.title || "finding").join(", ")}`,
    );
  }

  return { ok: errors.length === 0, errors };
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
