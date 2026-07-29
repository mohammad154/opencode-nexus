/**
 * Monotonic policy helpers — persisted state is authoritative.
 * Transition context may escalate, never weaken.
 */

export const REVIEW_RANK = { none: 0, unified: 1, dual: 2 };
export const PROFILE_RANK = { fast: 0, balanced: 1, strict: 2 };
export const EXEC_RANK = { direct: 0, delegated: 1 };

export function maxReview(a, b) {
  const ra = REVIEW_RANK[a] ?? 0;
  const rb = REVIEW_RANK[b] ?? 0;
  return ra >= rb ? a || "none" : b;
}

export function maxProfile(a, b) {
  const ra = PROFILE_RANK[a] ?? 1;
  const rb = PROFILE_RANK[b] ?? 1;
  return ra >= rb ? a || "balanced" : b;
}

export function maxExecution(a, b) {
  const ra = EXEC_RANK[a] ?? 1;
  const rb = EXEC_RANK[b] ?? 1;
  return ra >= rb ? a || "delegated" : b;
}

/**
 * Policy fields come only from persisted run state (+ classification snapshot).
 * Context may request escalation via escalate_* flags; never downgrade.
 */
export function effectivePolicy(state, ctx = {}) {
  const c = state?.classification || {};
  let review_level = state?.review_level || c.review_level || "unified";
  let profile = state?.profile || c.profile || "balanced";
  let execution_mode = state?.execution_mode || c.execution_mode || "delegated";

  // Monotonic escalation only from explicit escalate hints (not raw overrides)
  if (ctx.escalate_review_to) {
    review_level = maxReview(review_level, ctx.escalate_review_to);
  }
  if (ctx.escalate_profile_to) {
    profile = maxProfile(profile, ctx.escalate_profile_to);
  }
  if (ctx.escalate_execution_to) {
    execution_mode = maxExecution(execution_mode, ctx.escalate_execution_to);
  }

  // Reject any attempt to pass weaker policy via ctx
  if (
    ctx.review_level &&
    (REVIEW_RANK[ctx.review_level] ?? 0) < (REVIEW_RANK[review_level] ?? 0)
  ) {
    /* ignored — stored wins */
  }
  if (
    ctx.profile &&
    (PROFILE_RANK[ctx.profile] ?? 0) < (PROFILE_RANK[profile] ?? 0)
  ) {
    /* ignored */
  }
  if (ctx.execution_mode === "direct" && execution_mode === "delegated") {
    /* ignored — cannot weaken to direct via JSON */
  }

  const direct_eligible =
    c.direct_eligible === true &&
    (state?.execution_mode === "direct" || c.execution_mode === "direct");

  return {
    review_level,
    profile,
    execution_mode,
    direct_eligible,
    confidence: c.confidence ?? null,
    change_class: c.change_class || state?.change_class || null,
  };
}

export function applyBlastEscalation(state, blastReport) {
  const risk = blastReport?.risk || blastReport?.level;
  if (risk !== "HIGH") {
    return { ...state, blast: blastReport };
  }
  const reasons = [...(state.escalation_reasons || [])];
  if (!reasons.includes("blast_risk_high")) reasons.push("blast_risk_high");
  return {
    ...state,
    blast: blastReport,
    review_level: maxReview(state.review_level, "dual"),
    profile: maxProfile(state.profile, "strict"),
    execution_mode: maxExecution(state.execution_mode, "delegated"),
    escalation_reasons: reasons,
  };
}

export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertValidRunId(runId) {
  if (!runId || typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new Error(`invalid run_id "${runId}": must match ${RUN_ID_RE}`);
  }
  if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) {
    throw new Error(`invalid run_id "${runId}": path separators not allowed`);
  }
  return runId;
}
