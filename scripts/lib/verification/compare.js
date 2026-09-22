/**
 * Compare baseline vs current verification — distinguish pre-existing vs new regressions.
 */
export function compareBaselines(baseline, current) {
  const baseMap = new Map(
    (baseline?.results || []).map((r) => [r.id || r.command, r]),
  );
  const curList = current?.results || [];
  const new_regressions = [];
  const pre_existing_failures = [];
  const fixed = [];

  for (const cur of curList) {
    const key = cur.id || cur.command;
    const prev = baseMap.get(key);
    if (cur.pass === false) {
      if (prev && prev.pass === false) {
        pre_existing_failures.push(cur);
      } else {
        new_regressions.push(cur);
      }
    } else if (cur.pass === true && prev && prev.pass === false) {
      fixed.push(cur);
    }
  }

  return {
    ok: new_regressions.length === 0,
    new_regressions,
    pre_existing_failures,
    fixed,
  };
}

/**
 * Risk-based verification ladder.
 *
 * `levels` are always required. `fallback_levels` are required only when the
 * ladder's targeted evidence is unavailable, so a project that defines just
 * `npm test` still receives real verification. Callers must resolve the
 * fallback via `applyLadder` / `resolveLadderLevels` rather than assuming
 * `levels` is the complete requirement.
 */
export function verificationLadder(risk = "MEDIUM") {
  const r = String(risk).toUpperCase();
  if (r === "LOW") {
    // Targeted related tests plus cheap lint are enough for a low-risk change.
    // The full suite is a fallback when no executable targeted evidence exists,
    // not an additional default: running related tests *and* the whole suite
    // measured the same code twice.
    return {
      levels: ["related_tests", "lint"],
      fallback_levels: ["full_tests"],
      require_full: false,
    };
  }
  if (r === "MEDIUM") {
    return {
      levels: ["related_tests", "lint", "typecheck", "full_tests"],
      fallback_levels: [],
      require_full: false,
    };
  }
  if (r === "HIGH") {
    return {
      levels: ["related_tests", "full_tests", "lint", "typecheck", "build"],
      fallback_levels: [],
      require_full: true,
    };
  }
  // CRITICAL
  return {
    levels: [
      "related_tests",
      "full_tests",
      "lint",
      "typecheck",
      "build",
      "mutation_optional",
    ],
    fallback_levels: [],
    require_full: true,
    dual_review: true,
  };
}

/**
 * Conditions that force the full suite regardless of ladder tier.
 *
 * Reasons are returned so the decision stays auditable: a ladder that skips the
 * full suite must be able to show why that was admissible.
 */
export function fullSuiteForcingReasons(options = {}) {
  const reasons = [];
  if (options.require_full === true || options.force_full_tests === true) {
    reasons.push("explicit_policy");
  }
  const confidence = Number(options.confidence);
  if (Number.isFinite(confidence) && confidence < 0.75) {
    reasons.push("low_impact_confidence");
  }
  const risk = String(options.risk || options.risk_tier || "").toUpperCase();
  if (risk === "UNKNOWN" || risk === "") reasons.push("unknown_impact");
  if (options.analysis_complete === false) reasons.push("incomplete_analysis");
  if (options.public_contract === true) reasons.push("public_contract");
  if (options.scope_escalated === true) reasons.push("scope_escalation");
  if (options.baseline_required === true) reasons.push("baseline_requirement");
  return reasons;
}
