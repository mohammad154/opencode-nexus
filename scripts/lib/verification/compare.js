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
 */
export function verificationLadder(risk = "MEDIUM") {
  const r = String(risk).toUpperCase();
  if (r === "LOW") {
    // full_tests is a safety net when related_tests/lint are unavailable —
    // otherwise fail-closed verification would reject every low-risk Node project
    // that only defines `npm test`.
    return {
      levels: ["related_tests", "lint", "full_tests"],
      require_full: false,
    };
  }
  if (r === "MEDIUM") {
    return {
      levels: ["related_tests", "lint", "typecheck", "full_tests"],
      require_full: false,
    };
  }
  if (r === "HIGH") {
    return {
      levels: ["related_tests", "full_tests", "lint", "typecheck", "build"],
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
    require_full: true,
    dual_review: true,
  };
}
