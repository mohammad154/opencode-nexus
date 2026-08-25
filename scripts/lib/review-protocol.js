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

export function isLikelyProductionPath(file) {
  const f = String(file || "").replace(/\\/g, "/");
  if (!f || f.startsWith(".opencode/")) return false;
  if (/(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(f)) return false;
  if (/\.(test|spec)\.[a-z0-9]+$/i.test(f)) return false;
  if (/(^|\/)docs?(\/|$)/i.test(f)) return false;
  if (/\.(md|txt|rst)$/i.test(f)) return false;
  return true;
}

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

function normPath(p) {
  return String(p || "")
    .trim()
    .replace(/\\/g, "/");
}

/**
 * Expected acceptance list for this review (task or aggregated final).
 */
export function expectedAcceptanceCriteria(state = {}, opts = {}) {
  if (Array.isArray(opts.acceptance_criteria) && opts.acceptance_criteria.length) {
    return opts.acceptance_criteria.map(String);
  }
  if (
    opts.review_scope === "final" &&
    Array.isArray(state.task_history) &&
    state.task_history.length
  ) {
    return state.task_history.flatMap((t) =>
      Array.isArray(t.acceptance_criteria) ? t.acceptance_criteria.map(String) : [],
    );
  }
  if (Array.isArray(state.acceptance_criteria) && state.acceptance_criteria.length) {
    return state.acceptance_criteria.map(String);
  }
  return [];
}

/**
 * Gate-level check: an APPROVED string alone is never sufficient.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function isApprovalAdmissible(handoff, state = {}, opts = {}) {
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
  const expected = expectedAcceptanceCriteria(state, {
    review_scope: handoff.review_scope || opts.review_scope,
    acceptance_criteria: opts.acceptance_criteria,
  });
  const minAcceptance = expected.length > 0 ? expected.length : 1;
  if (acceptance.length < minAcceptance) {
    errors.push(
      `APPROVED requires at least ${minAcceptance} evidence-backed acceptance entr${minAcceptance === 1 ? "y" : "ies"} (got ${acceptance.length})`,
    );
  }

  // Exact-match: each persisted criterion must have a PASS entry (by AC-N id or text).
  if (expected.length > 0) {
    for (let i = 0; i < expected.length; i++) {
      const want = expected[i];
      const id = `AC-${i + 1}`;
      const match = acceptance.find(
        (ac) =>
          ac &&
          (String(ac.id) === id ||
            String(ac.id).toLowerCase() === want.toLowerCase() ||
            String(ac.criterion || "").toLowerCase() === want.toLowerCase() ||
            (Array.isArray(ac.evidence) &&
              ac.evidence.some((e) =>
                String(e.reason || "")
                  .toLowerCase()
                  .includes(want.toLowerCase().slice(0, 40)),
              ))),
      );
      if (!match) {
        errors.push(
          `APPROVED missing acceptance coverage for criterion ${id} (${want})`,
        );
      } else if (match.status !== "PASS") {
        errors.push(
          `acceptance for ${id} must be PASS for APPROVED (got ${match.status})`,
        );
      } else if (!hasAcceptanceEvidence(match.evidence)) {
        errors.push(`acceptance for ${id} requires non-empty file/reason evidence`);
      }
    }
  } else {
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
  }

  const files = Array.isArray(handoff.files_reviewed)
    ? handoff.files_reviewed.map(normPath).filter(Boolean)
    : [];
  if (files.length === 0) {
    errors.push("APPROVED requires non-empty files_reviewed");
  }

  const reviewedSet = new Set(files);
  const skipped = Array.isArray(handoff.files_skipped)
    ? handoff.files_skipped
    : [];
  const skippedSet = new Set(
    skipped
      .map((s) => (typeof s === "string" ? s : s?.file))
      .map(normPath)
      .filter(Boolean),
  );
  for (const s of skipped) {
    if (s && typeof s === "object" && s.file && !(s.reason && String(s.reason).trim())) {
      errors.push(`files_skipped entry for ${s.file} requires reason`);
    }
  }

  const pkg = opts.review_package || state.review_package || null;
  const mustReview = (
    opts.required_files ||
    pkg?.production_files ||
    (pkg?.changed_files || []).filter(isLikelyProductionPath) ||
    []
  )
    .map(normPath)
    .filter(Boolean);

  for (const f of mustReview) {
    if (!reviewedSet.has(f) && !skippedSet.has(f)) {
      errors.push(
        `APPROVED requires files_reviewed (or explicit files_skipped+reason) to cover changed production file: ${f}`,
      );
    }
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
