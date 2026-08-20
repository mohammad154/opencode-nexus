import { reclassifyAfterBlast } from "./classify.js";

/**
 * Monotonic policy helpers — persisted state is authoritative.
 * Transition context may escalate, never weaken.
 */

export const REVIEW_RANK = { none: 0, unified: 1, dual: 2 };
export const PROFILE_RANK = { fast: 0, balanced: 1, strict: 2 };
export const EXEC_RANK = { direct: 0, delegated: 1 };

export function blastRisk(report) {
  return String(report?.risk || report?.level || "").toUpperCase() || null;
}

export function isUnknownBlast(report) {
  if (!report || typeof report !== "object") return true;
  const risk = blastRisk(report);
  const analysisQuality = String(report.analysis_quality || "").toUpperCase();
  const graphQuality = String(report.graph_quality || "").toUpperCase();
  return (
    risk === "UNKNOWN" ||
    report.trusted === false ||
    report.analysis_complete === false && analysisQuality !== "" ||
    ["UNKNOWN", "UNSUPPORTED", "CONSERVATIVE"].includes(analysisQuality) ||
    ["UNKNOWN", "UNSUPPORTED", "CONSERVATIVE"].includes(graphQuality) ||
    report.analysis_quality === "UNKNOWN" ||
    report.graph_quality === "UNKNOWN" ||
    report.graph_freshness?.valid === false ||
    report.stale === true ||
    report.fresh === false
  );
}

export function isUnknownGraph(graph) {
  if (!graph || typeof graph !== "object") return true;
  const snapshot = graph.snapshot && typeof graph.snapshot === "object"
    ? graph.snapshot
    : graph;
  const quality = String(
    graph.quality || graph.extractor_quality || graph.extractor?.quality ||
      snapshot.extractor_quality || snapshot.extractor?.quality || "",
  ).toUpperCase();
  const fresh =
    graph.stale === false ||
    graph.fresh === true ||
    graph.freshness?.valid === true ||
    snapshot.fresh === true ||
    snapshot.freshness?.valid === true;
  return (
    graph.ok === false ||
    graph.trusted !== true ||
    quality !== "PRECISE" ||
    !fresh ||
    graph.stale === true ||
    graph.fresh === false ||
    graph.freshness?.valid === false ||
    snapshot.stale === true ||
    snapshot.fresh === false ||
    snapshot.freshness?.valid === false ||
    quality === "UNKNOWN" ||
    quality === "UNSUPPORTED" ||
    String(graph.provider_quality || "").toLowerCase() === "unknown"
  );
}

export function isTrustedLowRiskBlast(report) {
  if (!report || typeof report !== "object" || blastRisk(report) !== "LOW") {
    return false;
  }
  const analysisQuality = String(report.analysis_quality || "").toUpperCase();
  const graphQuality = String(report.graph_quality || "").toUpperCase();
  const fresh = report.graph_freshness?.valid === true;
  const precise = analysisQuality === "PRECISE" && graphQuality === "PRECISE";
  return (report.trusted === true || precise) && fresh && report.analysis_complete !== false;
}

export function hasExplicitBlastVerification(value) {
  if (value === true) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return value.verified === true;
}

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
    c.evidence_source === "git-diff" &&
    c.diff_verified === true &&
    c.diff_available === true &&
    c.diff_clean !== true &&
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
  return applyImpactEscalation(state, blastReport);
}

export function applyImpactEscalation(state, impactReport) {
  const previous = state?.classification || {
    profile: state?.profile,
    review_level: state?.review_level,
    execution_mode: state?.execution_mode,
    change_class: state?.change_class,
  };
  const reclassified = reclassifyAfterBlast(previous, impactReport, {
    graph: state?.graph,
  });
  const risk = blastRisk(impactReport);
  const reasons = [...(state.escalation_reasons || [])];
  if (
    (risk === "HIGH" || risk === "CRITICAL") &&
    !reasons.includes("impact_risk_high")
  ) {
    reasons.push("impact_risk_high");
  }
  if (isUnknownImpact(impactReport) && !reasons.includes("unknown_impact")) {
    reasons.push("unknown_impact");
  }
  if (
    typeof impactReport?.confidence === "number" &&
    impactReport.confidence < 0.75 &&
    !reasons.includes("low_impact_confidence")
  ) {
    reasons.push("low_impact_confidence");
  }
  let profile = maxProfile(state?.profile, reclassified.profile);
  let review_level = maxReview(state?.review_level, reclassified.review_level);
  if (
    typeof impactReport?.confidence === "number" &&
    impactReport.confidence < 0.75
  ) {
    review_level = maxReview(review_level, "dual");
    profile = maxProfile(profile, "strict");
  }
  const execution_mode = maxExecution(
    state?.execution_mode,
    reclassified.execution_mode,
  );
  return {
    ...state,
    impact: impactReport,
    blast: impactReport,
    classification: {
      ...previous,
      ...reclassified,
      profile,
      review_level,
      execution_mode,
      direct_eligible: false,
    },
    review_level,
    profile,
    execution_mode,
    escalation_reasons: reasons,
  };
}

export function isUnknownImpact(report) {
  if (!report || typeof report !== "object") return true;
  if (typeof report.confidence === "number" && report.confidence < 0.5) {
    return true;
  }
  return isUnknownBlast(report);
}

export function isTrustedLowRiskImpact(report) {
  if (!report || typeof report !== "object") return false;
  const risk = blastRisk(report);
  if (risk !== "LOW") return false;
  if (typeof report.confidence === "number" && report.confidence < 0.85) {
    return false;
  }
  // Prefer explicit impact trust markers; fall back to blast-shaped trust.
  if (report.provider === "nexus-impact" || report.graph_provider === "nexus-impact") {
    return (
      report.trusted === true &&
      report.analysis_complete !== false &&
      (report.graph_freshness?.valid === true || report.analysis_quality === "PRECISE")
    );
  }
  return isTrustedLowRiskBlast(report);
}

export function hasExplicitImpactVerification(value) {
  return hasExplicitBlastVerification(value);
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

/** TDD is policy-driven — implementer cannot opt out. */
const TDD_CHANGE_CLASSES = new Set([
  "bug-fix",
  "bug_fix",
  "behavioral-change",
  "behavioral_change",
  "regression-fix",
  "regression_fix",
]);

export function resolvedRunUnits(state = {}) {
  const candidate =
    state.units ??
    state.execution_units ??
    state.classification?.units ??
    state.task_count;
  const units = Number(candidate);
  return Number.isFinite(units) && units > 0 ? Math.floor(units) : 1;
}

export function isMultiTaskRun(state = {}) {
  if (resolvedRunUnits(state) > 1) return true;
  if (Array.isArray(state.tasks) && state.tasks.length > 1) return true;
  if (Array.isArray(state.execution_units) && state.execution_units.length > 1) {
    return true;
  }
  const planTasks = state.plan?.tasks ?? state.plan?.task_count;
  if (typeof planTasks === "number" && planTasks > 1) return true;
  if (Array.isArray(planTasks) && planTasks.length > 1) return true;
  return false;
}

export function requiresTdd(state = {}, classification = null) {
  const cls = classification || state.classification || {};
  const changeClass = cls.change_class || state.change_class;
  if (changeClass && TDD_CHANGE_CLASSES.has(String(changeClass))) return true;
  const triggers = cls.hard_triggers || state.hard_triggers || [];
  if (
    triggers.some((t) =>
      ["bug_fix", "behavioral_change", "regression_fix"].includes(String(t)),
    )
  ) {
    return true;
  }
  if (cls.semantic_signals?.includes("behavioral_change")) return true;
  return false;
}
