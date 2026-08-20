/**
 * Risk engine — danger if wrong, independent of impact confidence.
 */
const CRITICAL_PATHS = [
  /auth/i,
  /credential/i,
  /secret/i,
  /password/i,
  /migration/i,
  /security/i,
];

const HIGH_PATHS = [
  /schema/i,
  /protocol/i,
  /api\//i,
  /public/i,
  /package\.json$/i,
  /package-lock\.json$/i,
];

export function computeRisk({
  changed_files = [],
  changed_symbols = [],
  direct_dependents = [],
  confidence = 1,
  change_class = null,
  missing_tests = false,
  added_lines = 0,
  deleted_lines = 0,
} = {}) {
  let rank = 0; // 0 LOW, 1 MEDIUM, 2 HIGH, 3 CRITICAL
  const signals = [];

  const paths = changed_files.map((f) => (typeof f === "string" ? f : f.path)).filter(Boolean);

  for (const p of paths) {
    if (CRITICAL_PATHS.some((re) => re.test(p))) {
      rank = Math.max(rank, 3);
      signals.push("security_or_migration_path");
    }
    if (HIGH_PATHS.some((re) => re.test(p))) {
      rank = Math.max(rank, 2);
      signals.push("public_api_or_schema_path");
    }
  }

  const cls = String(change_class || "").toLowerCase();
  if (["authentication-security", "database-migration"].includes(cls)) {
    rank = Math.max(rank, 3);
    signals.push(`change_class:${cls}`);
  } else if (["public-api", "dependency-update"].includes(cls)) {
    rank = Math.max(rank, 2);
    signals.push(`change_class:${cls}`);
  }

  const exportedChanged = (changed_symbols || []).filter((s) => s.exported);
  if (exportedChanged.length > 0) {
    rank = Math.max(rank, 1);
    signals.push("exported_symbol_change");
  }
  if ((direct_dependents || []).length >= 8) {
    rank = Math.max(rank, 2);
    signals.push("high_fan_in");
  } else if ((direct_dependents || []).length >= 3) {
    rank = Math.max(rank, 1);
    signals.push("many_direct_callers");
  }

  const packages = new Set(
    paths.map((p) => p.split("/")[0]).filter((p) => p && p !== "tests" && p !== "test"),
  );
  if (packages.size >= 2) {
    rank = Math.max(rank, 1);
    signals.push("cross_package_change");
  }

  if (missing_tests) {
    rank = Math.max(rank, 1);
    signals.push("missing_tests");
  }

  if (confidence < 0.75) {
    rank = Math.max(rank, 1);
    signals.push("low_impact_confidence");
  }

  // Weak signals: size
  if (added_lines + deleted_lines > 400) {
    rank = Math.max(rank, 1);
    signals.push("large_diff_weak");
  }

  const levels = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  return {
    risk: levels[rank],
    risk_rank: rank,
    signals: [...new Set(signals)],
  };
}
