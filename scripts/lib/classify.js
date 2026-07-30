import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILES = path.resolve(
  __dirname,
  "../../config/workflow-profiles.json",
);

const DEFAULT_V2 = {
  version: 2,
  default: "balanced",
  hard_strict_triggers: [
    "security",
    "migration",
    "public_api",
    "credential_handling",
    "blast_risk_high",
  ],
  risk_weights: {
    files_changed_over_5: 2,
    estimated_lines_over_200: 2,
    high_fan_in_symbol: 3,
    missing_tests: 2,
    cross_package_change: 2,
    generated_file_change: 1,
    files_changed_over_2: 1,
    estimated_lines_over_50: 1,
    exported_symbol_change: 2,
  },
  thresholds: {
    fast_max: 1,
    balanced_max: 5,
    strict_min: 6,
  },
  direct_path: {
    max_risk_score: 0,
    max_files: 1,
    max_lines: 30,
    require_focused_validation: true,
    forbid_exported_symbol_change: true,
    min_confidence: 0.85,
    allowed_classes: ["documentation", "formatting", "one_file_internal"],
  },
  allowExplicitOverride: true,
  escalateToStrictOnHighBlast: true,
};

const VALID_PROFILES = ["fast", "balanced", "strict"];
const PROFILE_RANK = { fast: 0, balanced: 1, strict: 2 };

/**
 * Map legacy v1 classificationRules (with ambiguous fastIf.or) to v2 scoring.
 * Interprets the nested "or" block as AND (documented intent).
 */
export function migrateV1RulesToV2(v1) {
  const base = { ...DEFAULT_V2 };
  if (!v1 || typeof v1 !== "object") return base;
  if (v1.default) base.default = v1.default;
  if (typeof v1.allowExplicitOverride === "boolean") {
    base.allowExplicitOverride = v1.allowExplicitOverride;
  }
  if (typeof v1.escalateToStrictOnHighBlast === "boolean") {
    base.escalateToStrictOnHighBlast = v1.escalateToStrictOnHighBlast;
  }
  if (Array.isArray(v1.strictIf)) {
    const map = {
      securitySensitive: "security",
      databaseMigration: "migration",
      publicApi: "public_api",
      blastRiskHigh: "blast_risk_high",
    };
    base.hard_strict_triggers = [
      ...new Set(v1.strictIf.map((k) => map[k] || k)),
    ];
  }
  // Preserve documented AND semantics for tiny-internal (ignore misleading "or" key name)
  return base;
}

export function loadClassificationRules(profilesPath = DEFAULT_PROFILES) {
  return loadWorkflowConfig(profilesPath).classificationRules;
}

/**
 * Load full workflow config (classificationRules + reviewMatrix).
 */
export function loadWorkflowConfig(profilesPath = DEFAULT_PROFILES) {
  let raw = {};
  if (fs.existsSync(profilesPath)) {
    raw = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
  }
  const rulesIn = raw.classificationRules || {};
  let classificationRules;
  if (rulesIn.version === 2) {
    classificationRules = {
      ...DEFAULT_V2,
      ...rulesIn,
      risk_weights: {
        ...DEFAULT_V2.risk_weights,
        ...(rulesIn.risk_weights || {}),
      },
      thresholds: { ...DEFAULT_V2.thresholds, ...(rulesIn.thresholds || {}) },
      direct_path: {
        ...DEFAULT_V2.direct_path,
        ...(rulesIn.direct_path || {}),
      },
    };
  } else {
    classificationRules = migrateV1RulesToV2(rulesIn);
  }
  return {
    classificationRules,
    reviewMatrix: raw.reviewMatrix || {},
    profiles: raw.profiles || {},
  };
}

/** Map change_class strings to hard-trigger / risk flags */
export const CLASS_FLAGS = {
  documentation: ["documentation"],
  formatting: ["formatting"],
  one_file_internal: ["one_file_internal"],
  "test-only": ["one_file_internal"],
  "small-internal-refactor": ["one_file_internal"],
  "public-api": ["public_api"],
  public_api: ["public_api"],
  "authentication-security": ["security"],
  security: ["security"],
  "database-migration": ["migration"],
  migration: ["migration"],
  "credential-handling": ["credential_handling"],
  credential_handling: ["credential_handling"],
  "high-blast": ["blast_risk_high"],
  blast_risk_high: ["blast_risk_high"],
};

function reviewLevelFor(profile, changeClass, reviewMatrix) {
  if (profile === "strict") return "dual";
  const row = reviewMatrix?.[changeClass];
  if (changeClass === "documentation" || changeClass === "formatting")
    return "none";
  if (row) {
    if (row.unified === false && row.spec === "required") return "dual";
    if (row.unified === true) return "unified";
    if (
      row.spec === "skip" &&
      (row.code === "skip-or-lightweight" || row.code === "skip")
    ) {
      return "none";
    }
  }
  if (profile === "fast") return "unified";
  return "unified";
}

function profileOverrideFor(input) {
  const value = input.profileOverride ?? input.profile_override;
  if (value == null) return null;
  if (!VALID_PROFILES.includes(value)) {
    throw new RangeError(
      `Invalid profile override: ${String(value)}. Expected fast, balanced, or strict`,
    );
  }
  return value;
}

function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function evidenceForInput(input, files, lines) {
  const changedFiles = stringArray(input.changed_files ?? input.changedFiles);
  const changedExportedSymbols = stringArray(
    input.changed_exported_symbols ?? input.changedExportedSymbols,
  );
  const changedTestFiles = stringArray(
    input.changed_test_files ?? input.changedTestFiles,
  );
  const packageBoundaries = stringArray(input.package_boundaries);
  const workspaceBoundaries = stringArray(input.workspace_boundaries);
  return {
    changed_files: changedFiles,
    files_changed: files,
    added_lines: nonNegativeNumber(input.added_lines ?? input.addedLines),
    deleted_lines: nonNegativeNumber(input.deleted_lines ?? input.deletedLines),
    changed_lines: nonNegativeNumber(
      input.changed_lines ?? input.changedLines ?? lines,
    ),
    estimated_lines: lines,
    changed_exported_symbols: changedExportedSymbols,
    changed_test_files: changedTestFiles,
    package_boundaries: packageBoundaries,
    workspace_boundaries: workspaceBoundaries,
  };
}

/**
 * @param {object} input
 * @param {object} [options]
 * @returns {object} classification evidence
 */
export function classify(input = {}, options = {}) {
  const cfg =
    options.workflowConfig ||
    (options.rules
      ? {
          classificationRules: options.rules,
          reviewMatrix: options.reviewMatrix || {},
        }
      : loadWorkflowConfig(options.profilesPath));
  const rules = cfg.classificationRules;
  const reviewMatrix = cfg.reviewMatrix || options.reviewMatrix || {};
  const reasons = [];
  let risk_score = 0;
  let confidence = 0.7;

  const profileOverride = profileOverrideFor(input);
  const files = nonNegativeNumber(input.filesChanged ?? input.files_changed);
  const lines = nonNegativeNumber(input.estimatedLines ?? input.estimated_lines);
  const changeClass =
    input.changeClass || input.change_class || "small-feature-with-tests";
  const evidenceSource =
    input.evidence_source || input.evidenceSource || "explicit-input";
  const evidence = evidenceForInput(input, files, lines);
  const flags = new Set(
    [].concat(input.flags || [], input.hard_triggers || []),
  );

  // Class name alone activates corresponding flags
  for (const f of CLASS_FLAGS[changeClass] || []) flags.add(f);

  if (input.documentationOnly || changeClass === "documentation") {
    flags.add("documentation");
  }
  if (input.securitySensitive || input.security) flags.add("security");
  if (input.databaseMigration || input.migration) flags.add("migration");
  if (input.publicApi || input.public_api) flags.add("public_api");
  if (input.credentialHandling || input.credential_handling)
    flags.add("credential_handling");
  if (
    input.blastRiskHigh ||
    input.blast_risk_high ||
    input.blastRisk === "HIGH"
  ) {
    flags.add("blast_risk_high");
  }
  if (input.exportedSymbolChange || input.exported_symbol_change) {
    flags.add("exported_symbol_change");
  }
  if (evidence.changed_exported_symbols.length > 0) {
    flags.add("exported_symbol_change");
  }
  if (input.missingTests || input.missing_tests) flags.add("missing_tests");
  if (input.crossPackageChange || input.cross_package_change)
    flags.add("cross_package_change");
  if (evidence.package_boundaries.length > 1) {
    flags.add("cross_package_change");
  }
  if (input.generatedFileChange || input.generated_file_change)
    flags.add("generated_file_change");
  if (input.highFanIn || input.high_fan_in_symbol)
    flags.add("high_fan_in_symbol");
  if (input.formattingOnly || changeClass === "formatting")
    flags.add("formatting");
  if (input.oneFileInternal || changeClass === "one_file_internal")
    flags.add("one_file_internal");
  if (input.focusedValidation === true || input.focused_validation === true) {
    flags.add("focused_validation");
  }

  if (evidenceSource === "git-diff") {
    if (input.diff_clean === true) {
      reasons.push("Git diff evidence: no changed files detected");
    } else {
      reasons.push(
        `Git diff evidence: ${files} changed file(s), +${evidence.added_lines}/-${evidence.deleted_lines} lines`,
      );
    }
    if (evidence.changed_exported_symbols.length > 0) {
      reasons.push(
        `Git diff changed exported symbol(s): ${evidence.changed_exported_symbols.join(", ")}`,
      );
    }
    if (evidence.changed_test_files.length > 0) {
      reasons.push(
        `Git diff changed test file(s): ${evidence.changed_test_files.length}`,
      );
    }
    if (evidence.package_boundaries.length > 0) {
      reasons.push(
        `Git diff package boundary(ies): ${evidence.package_boundaries.join(", ")}`,
      );
    }
  } else if (evidenceSource === "explicit-input-fallback") {
    reasons.push(
      "Git diff evidence unavailable; explicit classification values retained only as a compatibility fallback",
    );
  } else if (evidenceSource === "explicit-input") {
    reasons.push("Using explicit classification input; no git diff was requested");
  }
  for (const warning of stringArray(input.evidence_warnings)) {
    reasons.push(`Evidence warning: ${warning}`);
  }

  // Hard triggers are evaluated before any profile override. A requested fast
  // or balanced profile must never weaken a security-sensitive policy.
  const hardHit = rules.hard_strict_triggers.filter((t) => flags.has(t));
  if (hardHit.length) {
    reasons.push(`Hard strict trigger(s): ${hardHit.join(", ")}`);
    if (profileOverride) {
      reasons.push(
        `Explicit profile override ${profileOverride} cannot downgrade hard strict work; preserving strict`,
      );
    }
    return finalize({
      profile: "strict",
      review_level: "dual",
      risk_score: Math.max(rules.thresholds.strict_min, 6 + hardHit.length),
      confidence: 0.95,
      reasons,
      changeClass,
      flags,
      rules,
      input,
      hard_triggers: hardHit,
    });
  }

  const w = rules.risk_weights;
  const lineLabel = evidenceSource === "git-diff" ? "Changed" : "Estimated";
  if (files > 5) {
    risk_score += w.files_changed_over_5;
    reasons.push(`Touches ${files} files (>5)`);
  } else if (files > 2) {
    risk_score += w.files_changed_over_2 || 1;
    reasons.push(`Touches ${files} files`);
  }
  if (lines > 200) {
    risk_score += w.estimated_lines_over_200;
    reasons.push(`${lineLabel} ${lines} lines (>200)`);
  } else if (lines > 50) {
    risk_score += w.estimated_lines_over_50 || 1;
    reasons.push(`${lineLabel} ${lines} lines`);
  }
  if (flags.has("high_fan_in_symbol")) {
    risk_score += w.high_fan_in_symbol;
    reasons.push("High fan-in symbol");
  }
  if (flags.has("missing_tests")) {
    risk_score += w.missing_tests;
    reasons.push("Missing tests");
  }
  if (flags.has("cross_package_change")) {
    risk_score += w.cross_package_change;
    reasons.push("Cross-package change");
  }
  if (flags.has("generated_file_change")) {
    risk_score += w.generated_file_change;
    reasons.push("Generated file change");
  }
  if (flags.has("exported_symbol_change")) {
    risk_score += w.exported_symbol_change;
    reasons.push("Changes exported symbol");
  }

  if (flags.has("documentation") || flags.has("formatting")) {
    confidence = Math.max(confidence, 0.9);
    if (files <= 2 && lines <= 50 && !flags.has("exported_symbol_change")) {
      reasons.push("Documentation/formatting change");
    }
  }

  // Tiny internal AND semantics (v1 docs intent): ≤2 files AND ≤50 lines AND not public/security
  const tinyInternal =
    files <= 2 &&
    lines <= 50 &&
    !flags.has("public_api") &&
    !flags.has("security") &&
    !flags.has("exported_symbol_change") &&
    (flags.has("one_file_internal") ||
      changeClass === "small-internal-refactor" ||
      changeClass === "test-only" ||
      flags.has("documentation") ||
      flags.has("formatting"));

  if (tinyInternal && risk_score <= rules.thresholds.fast_max) {
    reasons.push("Tiny internal / docs change under fast thresholds");
    confidence = Math.max(confidence, 0.88);
  } else if (risk_score === 0 && files <= 2 && lines <= 50) {
    // Still need positive evidence — do NOT treat bare size as fast (fixes OR bug)
    risk_score += 2;
    reasons.push("Ordinary change without tiny-internal markers → not fast");
    confidence = 0.75;
  }

  let profile = rules.default || "balanced";
  if (risk_score <= rules.thresholds.fast_max && tinyInternal) {
    profile = "fast";
  } else if (risk_score >= rules.thresholds.strict_min) {
    profile = "strict";
  } else if (risk_score <= rules.thresholds.balanced_max) {
    profile = "balanced";
  } else {
    profile = "strict";
  }

  if (profileOverride) {
    if (!rules.allowExplicitOverride) {
      reasons.push(`Explicit profile override ignored by workflow policy: ${profileOverride}`);
    } else if (PROFILE_RANK[profileOverride] < PROFILE_RANK[profile]) {
      reasons.push(
        `Explicit profile override ${profileOverride} cannot downgrade computed ${profile}; preserving ${profile}`,
      );
    } else {
      profile = profileOverride;
      reasons.push(`Explicit profile override: ${profileOverride}`);
    }
  }

  if (input.directCallers != null) {
    reasons.push(`Direct callers: ${input.directCallers}`);
    confidence = Math.min(1, confidence + 0.05);
  }
  if (input.existingFocusedTests) {
    reasons.push("Existing focused tests found");
    confidence = Math.min(1, confidence + 0.05);
  }

  const review_level = reviewLevelFor(profile, changeClass, reviewMatrix);
  return finalize({
    profile,
    review_level,
    risk_score,
    confidence,
    reasons,
    changeClass,
    flags,
    rules,
    input,
  });
}

function finalize({
  profile,
  review_level,
  risk_score,
  confidence,
  reasons,
  changeClass,
  flags,
  rules,
  input,
  hard_triggers = [],
}) {
  const dp = rules.direct_path;
  const allowedClass =
    dp.allowed_classes.includes(changeClass) ||
    flags.has("documentation") ||
    flags.has("formatting") ||
    flags.has("one_file_internal");

  const files = nonNegativeNumber(input.filesChanged ?? input.files_changed);
  const lines = nonNegativeNumber(input.estimatedLines ?? input.estimated_lines);
  const evidenceSource =
    input.evidence_source || input.evidenceSource || "explicit-input";
  const evidence = evidenceForInput(input, files, lines);
  const hasFocused =
    !dp.require_focused_validation ||
    flags.has("focused_validation") ||
    input.existingFocusedTests === true ||
    changeClass === "documentation" ||
    changeClass === "formatting";

  const noExport =
    !dp.forbid_exported_symbol_change || !flags.has("exported_symbol_change");

  const userForbidsDirect =
    input.executionMode === "delegated" ||
    input.execution_mode === "delegated" ||
    input.forbidDirect === true;

  const diffEvidenceIsNotDirectSafe =
    (input.diff_requested === true ||
      evidenceSource === "git-diff" ||
      evidenceSource === "explicit-input-fallback") &&
    (input.diff_clean === true ||
      input.diff_available === false ||
      evidenceSource === "explicit-input-fallback" ||
      (evidenceSource === "git-diff" && input.diff_available !== true));

  // Direct execution is an authorization decision, so size/class estimates
  // supplied by a caller (or model) can never authorize it. The CLI marks a
  // successfully collected diff with diff_verified; older callers remain
  // compatible for classification, but are always delegated.
  const authoritativeDiffEvidence =
    evidenceSource === "git-diff" &&
    input.diff_verified === true &&
    input.diff_available === true &&
    input.diff_clean !== true;

  const direct_eligible =
    !userForbidsDirect &&
    authoritativeDiffEvidence &&
    profile !== "strict" &&
    !diffEvidenceIsNotDirectSafe &&
    risk_score <= dp.max_risk_score &&
    files <= dp.max_files &&
    lines <= dp.max_lines &&
    allowedClass &&
    hasFocused &&
    noExport &&
    confidence >= dp.min_confidence &&
    hard_triggers.length === 0 &&
    !flags.has("security") &&
    !flags.has("public_api") &&
    !flags.has("migration") &&
    !flags.has("credential_handling") &&
    !flags.has("blast_risk_high");

  const execution_mode = direct_eligible ? "direct" : "delegated";
  if (!direct_eligible && confidence < dp.min_confidence) {
    reasons.push(
      `Direct path denied: confidence ${confidence.toFixed(2)} < ${dp.min_confidence}`,
    );
  }
  if (!direct_eligible && profile === "strict") {
    reasons.push("Direct path denied: strict profile requires delegated review");
  }
  if (!direct_eligible && diffEvidenceIsNotDirectSafe) {
    reasons.push(
      "Direct path denied: requested git diff is clean or unavailable",
    );
  }
  if (!direct_eligible && !authoritativeDiffEvidence) {
    reasons.push(
      "Direct path denied: only a successful, non-clean git diff can authorize direct execution",
    );
  }

  // Adjust review for direct docs
  let finalReview = review_level;
  if (
    execution_mode === "direct" &&
    (changeClass === "documentation" || changeClass === "formatting")
  ) {
    finalReview = "none";
  }

  return {
    schema_version: "1.0",
    profile,
    review_level: finalReview,
    execution_mode,
    risk_score,
    confidence: Number(confidence.toFixed(2)),
    reasons,
    direct_eligible,
    change_class: changeClass,
    hard_triggers,
    evidence_source: evidenceSource,
    diff_verified: input.diff_verified === true,
    diff_available: input.diff_available === true,
    diff_clean: input.diff_clean === true,
    evidence,
    changed_files: evidence.changed_files,
    added_lines: evidence.added_lines,
    deleted_lines: evidence.deleted_lines,
    changed_exported_symbols: evidence.changed_exported_symbols,
    changed_test_files: evidence.changed_test_files,
    package_boundaries: evidence.package_boundaries,
    workspace_boundaries: evidence.workspace_boundaries,
  };
}

export { DEFAULT_V2, DEFAULT_PROFILES };
