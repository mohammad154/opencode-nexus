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
  ],
  dual_review_triggers: [
    "security",
    "migration",
    "public_api",
    "credential_handling",
    "blast_risk_high",
  ],
  risk_weights: {
    files_changed_over_5: 1,
    estimated_lines_over_200: 1,
    files_changed_over_2: 0,
    estimated_lines_over_50: 0,
    generated_file_change: 1,
    high_fan_in_symbol: 4,
    missing_tests: 2,
    cross_package_change: 3,
    exported_symbol_change: 3,
    config_schema_protocol: 3,
    concurrency_async: 2,
    dependency_update: 2,
    database_storage: 3,
    blast_risk_medium: 2,
    blast_risk_high: 3,
    many_direct_callers: 2,
  },
  thresholds: {
    fast_max: 1,
    balanced_max: 5,
    strict_min: 6,
  },
  confidence_gates: {
    fast_min: 0.85,
    balanced_min: 0.65,
  },
  caller_thresholds: {
    high_fan_in: 8,
    many_direct: 15,
    low_direct: 1,
  },
  direct_path: {
    max_risk_score: 0,
    max_files: 1,
    max_lines: 30,
    require_focused_validation: true,
    forbid_exported_symbol_change: true,
    min_confidence: 0.85,
    allowed_classes: ["documentation", "formatting"],
  },
  allowExplicitOverride: true,
  escalateToStrictOnHighBlast: false,
  escalateReviewOnHighBlast: true,
};

const VALID_PROFILES = ["fast", "balanced", "strict"];
const PROFILE_RANK = { fast: 0, balanced: 1, strict: 2 };
const REVIEW_RANK = { none: 0, unified: 1, dual: 2 };
const EXEC_RANK = { direct: 0, delegated: 1 };
const SKIP_PATH_HARD_CLASSES = new Set([
  "documentation",
  "formatting",
  "test-only",
  "one_file_internal",
]);
const FEATURE_CLASSES = new Set([
  "small-feature-with-tests",
  "public-api",
  "authentication-security",
  "database-migration",
  "high-blast",
]);
const TEST_FILE_RE =
  /(^|\/)(?:tests?|__tests__)(\/|$)|(?:\.test|\.spec)\.[^/]+$/i;
const DOC_FILE_RE = /\.(md|mdx|txt|rst|adoc)$/i;

const PATH_SIGNAL_RULES = [
  {
    flag: "security",
    reason: "authentication subsystem",
    re: /(^|\/)(auth|oauth|saml|oidc|sso|session|credential|rbac|acl|permissions?)(\/|$)/i,
    // Hard signals are authoritative: a safer declared change_class can never
    // suppress them. The Git diff is the source of truth.
    hard: true,
  },
  {
    flag: "migration",
    reason: "database migration",
    re: /(^|\/)(migrations?|alembic|prisma\/migrations)(\/|$)|(?:^|\/).*(?:^|[-_.])migration(?:[-_.].*)?\.(sql|js|ts|py)$/i,
    hard: true,
  },
  {
    flag: "credential_handling",
    reason: "credential/secret handling",
    re: /(^|\/)(secrets?|credentials?|vault|keystore|keychain)(\/|$)|(?:^|[-_.])(secret|credential|private[-_.]?key)(?:[-_.][^/]*)?\.(json|ya?ml|env|pem|key)$/i,
    hard: true,
  },
  {
    flag: "database_storage",
    reason: "database/storage behavior",
    re: /\.sql$|(^|\/)(models|entities|repositories|storage)(\/|$)/i,
  },
  {
    flag: "config_schema_protocol",
    reason: "config/schema/protocol change",
    re: /(openapi|swagger|\.proto$|protobuf|graphql|avro|jsonschema|\.schema\.)/i,
  },
  {
    flag: "dependency_update",
    reason: "dependency update",
    re: /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|go\.sum|Cargo\.lock|Pipfile\.lock|poetry\.lock|requirements.*\.txt|composer\.lock)$/i,
  },
  {
    flag: "concurrency_async",
    reason: "concurrency/async behavior",
    re: /(^|\/)(workers?|queues?|jobs?|async)(\/|$)/i,
  },
];

const HARD_PATH_SIGNAL_RULES = PATH_SIGNAL_RULES.filter((rule) => rule.hard);
const SOFT_PATH_SIGNAL_RULES = PATH_SIGNAL_RULES.filter((rule) => !rule.hard);

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
  if (typeof v1.escalateReviewOnHighBlast === "boolean") {
    base.escalateReviewOnHighBlast = v1.escalateReviewOnHighBlast;
  }
  if (Array.isArray(v1.strictIf)) {
    const map = {
      securitySensitive: "security",
      databaseMigration: "migration",
      publicApi: "public_api",
      blastRiskHigh: "blast_risk_high",
    };
    const mapped = v1.strictIf.map((k) => map[k] || k);
    base.hard_strict_triggers = [
      ...new Set(mapped.filter((flag) => flag !== "blast_risk_high")),
    ];
    base.dual_review_triggers = [
      ...new Set([...(base.dual_review_triggers || []), ...mapped]),
    ];
  }
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
      confidence_gates: {
        ...DEFAULT_V2.confidence_gates,
        ...(rulesIn.confidence_gates || {}),
      },
      caller_thresholds: {
        ...DEFAULT_V2.caller_thresholds,
        ...(rulesIn.caller_thresholds || {}),
      },
      dual_review_triggers: rulesIn.dual_review_triggers || [
        ...DEFAULT_V2.dual_review_triggers,
      ],
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
  "bug-fix": ["bug_fix"],
  bug_fix: ["bug_fix"],
  "behavioral-change": ["behavioral_change"],
  behavioral_change: ["behavioral_change"],
  "regression-fix": ["regression_fix"],
  regression_fix: ["regression_fix"],
};

function maxByRank(rank, a, b, fallback) {
  const ra = rank[a] ?? -1;
  const rb = rank[b] ?? -1;
  if (ra < 0 && rb < 0) return fallback;
  return ra >= rb ? a || fallback : b;
}

function maxProfile(a, b) {
  return maxByRank(PROFILE_RANK, a, b, "balanced");
}

function maxReview(a, b) {
  return maxByRank(REVIEW_RANK, a, b, "unified");
}

function maxExecution(a, b) {
  return maxByRank(EXEC_RANK, a, b, "delegated");
}

function reviewLevelFor(profile, changeClass, reviewMatrix, flags, rules) {
  if (profile === "strict") return "dual";
  const dualTriggers =
    rules.dual_review_triggers || DEFAULT_V2.dual_review_triggers;
  if (dualTriggers.some((flag) => flags.has(flag))) return "dual";
  const row = reviewMatrix?.[changeClass];
  if (changeClass === "documentation" || changeClass === "formatting") {
    return "none";
  }
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

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
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

function allFilesAreTestsOrDocs(files) {
  if (!files.length) return false;
  return files.every(
    (file) => TEST_FILE_RE.test(file) || DOC_FILE_RE.test(file),
  );
}

function applyPathSignalRules(rules, changedFiles, flags, reasons) {
  for (const rule of rules) {
    if (flags.has(rule.flag)) continue;
    const hit = changedFiles.find((file) => rule.re.test(file));
    if (!hit) continue;
    flags.add(rule.flag);
    reasons.push(`${rule.reason} (${hit})`);
  }
}

function inferPathSignals(changedFiles, changeClass, flags, reasons) {
  if (!changedFiles.length) return;

  // Hard path signals (auth/security, migration, credential handling) are
  // authoritative and ALWAYS run. A declared safer change_class such as
  // documentation/formatting/test-only/one_file_internal — or an all-docs/tests
  // file set — can never suppress them, because the Git diff is the source of
  // truth. Suppressing a security signal by mislabeling a change must be
  // impossible.
  applyPathSignalRules(HARD_PATH_SIGNAL_RULES, changedFiles, flags, reasons);

  // Soft (size/behavior) signals may still be skipped for declared-safe
  // classes or all-docs/tests changes; they only influence weighted scoring.
  if (
    SKIP_PATH_HARD_CLASSES.has(changeClass) ||
    allFilesAreTestsOrDocs(changedFiles)
  ) {
    return;
  }
  applyPathSignalRules(SOFT_PATH_SIGNAL_RULES, changedFiles, flags, reasons);
}

function blastRiskOf(blast) {
  if (!blast || typeof blast !== "object") return null;
  const risk = String(blast.risk || blast.level || "").toUpperCase();
  return risk || null;
}

function isUnknownBlastEvidence(blast) {
  if (!blast || typeof blast !== "object") return false;
  const risk = blastRiskOf(blast);
  const analysisQuality = String(blast.analysis_quality || "").toUpperCase();
  const graphQuality = String(blast.graph_quality || "").toUpperCase();
  return (
    risk === "UNKNOWN" ||
    blast.trusted === false ||
    (blast.analysis_complete === false && analysisQuality !== "") ||
    ["UNKNOWN", "UNSUPPORTED", "CONSERVATIVE"].includes(analysisQuality) ||
    ["UNKNOWN", "UNSUPPORTED", "CONSERVATIVE"].includes(graphQuality) ||
    blast.stale === true ||
    blast.fresh === false ||
    blast.graph_freshness?.valid === false
  );
}

function isUnknownGraphEvidence(graph) {
  if (!graph || typeof graph !== "object") return false;
  const snapshot =
    graph.snapshot && typeof graph.snapshot === "object"
      ? graph.snapshot
      : graph;
  const quality = String(
    graph.quality ||
      graph.extractor_quality ||
      graph.extractor?.quality ||
      snapshot.quality ||
      snapshot.extractor_quality ||
      "",
  ).toUpperCase();
  if (graph.ok === false || graph.trusted === false || graph.stale === true) {
    return true;
  }
  if (graph.fresh === false || graph.freshness?.valid === false) return true;
  if (["UNKNOWN", "UNSUPPORTED", "CONSERVATIVE", "STALE"].includes(quality)) {
    return true;
  }
  if (graph.graph_stale === true) return true;
  return false;
}

function graphifySignalsFrom(input) {
  const graphify = asObject(input.graphify) || {};
  const blast = asObject(input.blast) || asObject(input.blast_report) || {};
  const hasDependents = Array.isArray(blast.direct_dependents);
  const hasImpacts = Array.isArray(blast.impacts);
  const dependents = hasDependents ? stringArray(blast.direct_dependents) : [];
  const impacts = hasImpacts ? blast.impacts : [];
  const explicitCallers =
    input.directCallers ?? input.direct_callers ?? graphify.direct_callers;
  const explicitTransitive =
    input.transitiveImpact ??
    input.transitive_impact ??
    graphify.transitive_impact;
  const directCallers = nonNegativeNumber(
    explicitCallers ?? (hasDependents ? dependents.length : NaN),
    NaN,
  );
  const transitive = nonNegativeNumber(
    explicitTransitive ?? (hasImpacts ? impacts.length : NaN),
    NaN,
  );
  const packages = stringArray(
    input.affected_packages ??
      graphify.affected_packages ??
      blast.affected_packages,
  );
  return {
    direct_callers: Number.isFinite(directCallers) ? directCallers : null,
    transitive_impact: Number.isFinite(transitive) ? transitive : null,
    affected_packages: packages,
    direct_dependents: dependents,
  };
}

function collectFlags(input, evidence, reasons) {
  const flags = new Set(
    [].concat(input.flags || [], input.hard_triggers || []),
  );
  const changeClass =
    input.changeClass || input.change_class || "small-feature-with-tests";

  for (const flag of CLASS_FLAGS[changeClass] || []) flags.add(flag);

  if (input.documentationOnly || changeClass === "documentation") {
    flags.add("documentation");
  }
  if (input.securitySensitive || input.security) flags.add("security");
  if (input.databaseMigration || input.migration) flags.add("migration");
  if (input.publicApi || input.public_api) flags.add("public_api");
  if (input.credentialHandling || input.credential_handling) {
    flags.add("credential_handling");
  }
  const blastRisk =
    blastRiskOf(input.blast) || String(input.blastRisk || "").toUpperCase();
  if (input.blastRiskHigh || input.blast_risk_high || blastRisk === "HIGH") {
    flags.add("blast_risk_high");
  }
  if (blastRisk === "MEDIUM") flags.add("blast_risk_medium");
  if (input.exportedSymbolChange || input.exported_symbol_change) {
    flags.add("exported_symbol_change");
  }
  if (evidence.changed_exported_symbols.length > 0) {
    flags.add("exported_symbol_change");
  }
  if (input.missingTests || input.missing_tests) flags.add("missing_tests");
  if (input.crossPackageChange || input.cross_package_change) {
    flags.add("cross_package_change");
  }
  if (evidence.package_boundaries.length > 1) {
    flags.add("cross_package_change");
  }
  if (input.generatedFileChange || input.generated_file_change) {
    flags.add("generated_file_change");
  }
  if (input.highFanIn || input.high_fan_in_symbol) {
    flags.add("high_fan_in_symbol");
  }
  if (input.configSchemaProtocol || input.config_schema_protocol) {
    flags.add("config_schema_protocol");
  }
  if (input.concurrencyAsync || input.concurrency_async) {
    flags.add("concurrency_async");
  }
  if (input.dependencyUpdate || input.dependency_update) {
    flags.add("dependency_update");
  }
  if (input.databaseStorage || input.database_storage) {
    flags.add("database_storage");
  }
  if (input.formattingOnly || changeClass === "formatting") {
    flags.add("formatting");
  }
  if (input.oneFileInternal || changeClass === "one_file_internal") {
    flags.add("one_file_internal");
  }
  if (input.focusedValidation === true || input.focused_validation === true) {
    flags.add("focused_validation");
  }

  inferPathSignals(evidence.changed_files, changeClass, flags, reasons);

  const productionFiles = evidence.changed_files.filter(
    (file) => !TEST_FILE_RE.test(file) && !DOC_FILE_RE.test(file),
  );
  if (
    FEATURE_CLASSES.has(changeClass) &&
    productionFiles.length > 0 &&
    evidence.changed_test_files.length === 0 &&
    !flags.has("documentation") &&
    !flags.has("formatting") &&
    !flags.has("missing_tests")
  ) {
    flags.add("missing_tests");
  }

  return flags;
}

function describeEvidenceSource(input, evidence, files, reasons) {
  const evidenceSource =
    input.evidence_source || input.evidenceSource || "explicit-input";
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
        `public exported symbol changed: ${evidence.changed_exported_symbols.join(", ")}`,
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
    reasons.push(
      "Using explicit classification input; no git diff was requested",
    );
  }
  for (const warning of stringArray(input.evidence_warnings)) {
    reasons.push(`Evidence warning: ${warning}`);
  }
  return evidenceSource;
}

function assessEvidenceQuality(input, stage) {
  const factors = [];
  const evidenceSource =
    input.evidence_source || input.evidenceSource || "explicit-input";
  const diffMissing =
    evidenceSource === "explicit-input-fallback" ||
    ((input.diff_requested === true || evidenceSource === "git-diff") &&
      input.diff_available === false);
  if (diffMissing) factors.push("diff evidence missing");

  const blast = asObject(input.blast) || asObject(input.blast_report);
  const graph = asObject(input.graph) || asObject(input.graphify);
  const graphify = asObject(input.graphify);
  if (input.graph_stale === true || graphify?.stale === true) {
    factors.push("Graphify stale");
  }
  if (input.blast_incomplete === true) factors.push("blast incomplete");
  if (input.dependency_analysis_failed === true) {
    factors.push("dependency analysis failed");
  }
  if (blast && isUnknownBlastEvidence(blast)) {
    if (!factors.includes("blast incomplete")) factors.push("blast incomplete");
  }
  if (graph && isUnknownGraphEvidence(graph)) {
    if (!factors.includes("Graphify stale")) factors.push("Graphify stale");
  }
  if (
    stage === "post-blast" &&
    !blast &&
    !input.blastRisk &&
    !input.blastRiskHigh
  ) {
    factors.push("blast incomplete");
  }

  if (factors.length) {
    return { evidence_quality: "unknown", uncertainty_factors: factors };
  }

  const gitOk =
    evidenceSource === "git-diff" &&
    input.diff_available === true &&
    input.diff_clean !== true;
  const blastTrusted =
    blast &&
    !isUnknownBlastEvidence(blast) &&
    String(blast.analysis_quality || "").toUpperCase() === "PRECISE" &&
    String(blast.graph_quality || "").toUpperCase() === "PRECISE";
  if (gitOk && blastTrusted) {
    return { evidence_quality: "trusted", uncertainty_factors: [] };
  }
  return { evidence_quality: "partial", uncertainty_factors: [] };
}

function addWeighted(risk, weight, reason, reasons) {
  const value = Number(weight) || 0;
  if (value <= 0) return risk;
  reasons.push(reason);
  return risk + value;
}

function scoreSemanticRisk(input, flags, files, lines, rules, reasons) {
  const w = rules.risk_weights;
  const callers = graphifySignalsFrom(input);
  const callerLimits = rules.caller_thresholds || DEFAULT_V2.caller_thresholds;
  let risk_score = 0;

  const lineLabel =
    (input.evidence_source || input.evidenceSource) === "git-diff"
      ? "Changed"
      : "Estimated";
  if (files > 5) {
    risk_score = addWeighted(
      risk_score,
      w.files_changed_over_5,
      `Touches ${files} files (>5) [weak size signal]`,
      reasons,
    );
  } else if (files > 2) {
    risk_score = addWeighted(
      risk_score,
      w.files_changed_over_2,
      `Touches ${files} files [weak size signal]`,
      reasons,
    );
  }
  if (lines > 200) {
    risk_score = addWeighted(
      risk_score,
      w.estimated_lines_over_200,
      `${lineLabel} ${lines} lines (>200) [weak size signal]`,
      reasons,
    );
  } else if (lines > 50) {
    risk_score = addWeighted(
      risk_score,
      w.estimated_lines_over_50,
      `${lineLabel} ${lines} lines [weak size signal]`,
      reasons,
    );
  }

  if (callers.direct_callers != null) {
    reasons.push(
      callers.direct_callers === 1
        ? "1 direct caller"
        : `${callers.direct_callers} direct callers`,
    );
    if (callers.direct_callers >= callerLimits.many_direct) {
      flags.add("high_fan_in_symbol");
      risk_score = addWeighted(
        risk_score,
        w.many_direct_callers,
        `Graphify: ${callers.direct_callers} direct callers`,
        reasons,
      );
    }
    if (callers.direct_callers >= callerLimits.high_fan_in) {
      flags.add("high_fan_in_symbol");
    } else if (
      callers.direct_callers <= callerLimits.low_direct &&
      (callers.transitive_impact == null || callers.transitive_impact <= 2)
    ) {
      reasons.push(
        "Graphify: direct callers = 1, transitive impact small → lower risk",
      );
    }
  }
  if (callers.transitive_impact != null && callers.transitive_impact > 0) {
    reasons.push(`transitive impact ${callers.transitive_impact}`);
  }
  if (callers.affected_packages.length > 1) {
    flags.add("cross_package_change");
  }

  if (flags.has("high_fan_in_symbol")) {
    risk_score = addWeighted(
      risk_score,
      w.high_fan_in_symbol,
      "high fan-in function changed",
      reasons,
    );
  }
  if (flags.has("missing_tests")) {
    risk_score = addWeighted(
      risk_score,
      w.missing_tests,
      "missing relevant tests",
      reasons,
    );
  }
  if (flags.has("cross_package_change")) {
    risk_score = addWeighted(
      risk_score,
      w.cross_package_change,
      "cross-package dependency",
      reasons,
    );
  }
  if (flags.has("generated_file_change")) {
    risk_score = addWeighted(
      risk_score,
      w.generated_file_change,
      "Generated file change",
      reasons,
    );
  }
  if (flags.has("exported_symbol_change")) {
    risk_score = addWeighted(
      risk_score,
      w.exported_symbol_change,
      "public exported symbol changed",
      reasons,
    );
  }
  if (flags.has("config_schema_protocol")) {
    risk_score = addWeighted(
      risk_score,
      w.config_schema_protocol,
      "config/schema/protocol change",
      reasons,
    );
  }
  if (flags.has("concurrency_async")) {
    risk_score = addWeighted(
      risk_score,
      w.concurrency_async,
      "concurrency/async behavior",
      reasons,
    );
  }
  if (flags.has("dependency_update")) {
    risk_score = addWeighted(
      risk_score,
      w.dependency_update,
      "dependency update",
      reasons,
    );
  }
  if (flags.has("database_storage") && !flags.has("migration")) {
    risk_score = addWeighted(
      risk_score,
      w.database_storage,
      "database/storage behavior",
      reasons,
    );
  }
  if (flags.has("blast_risk_high")) {
    risk_score = addWeighted(
      risk_score,
      w.blast_risk_high,
      "blast risk HIGH",
      reasons,
    );
  } else if (flags.has("blast_risk_medium")) {
    risk_score = addWeighted(
      risk_score,
      w.blast_risk_medium,
      "blast risk MEDIUM",
      reasons,
    );
  }

  return { risk_score, graphify: callers };
}

function tinyInternalEvidence(flags, changeClass, files, lines) {
  return (
    files <= 2 &&
    lines <= 50 &&
    !flags.has("public_api") &&
    !flags.has("security") &&
    !flags.has("exported_symbol_change") &&
    !flags.has("blast_risk_high") &&
    !flags.has("high_fan_in_symbol") &&
    !flags.has("cross_package_change") &&
    (flags.has("one_file_internal") ||
      changeClass === "small-internal-refactor" ||
      changeClass === "test-only" ||
      flags.has("documentation") ||
      flags.has("formatting"))
  );
}

function applyConfidenceGates(
  profile,
  confidence,
  evidenceQuality,
  gates,
  reasons,
) {
  let next = profile;
  if (evidenceQuality === "unknown" && next === "fast") {
    next = "balanced";
    reasons.push(
      "UNKNOWN evidence cannot be treated as low risk → FAST denied",
    );
  }
  if (
    confidence < gates.balanced_min &&
    PROFILE_RANK[next] < PROFILE_RANK.strict
  ) {
    next = "strict";
    reasons.push(
      `confidence ${confidence.toFixed(2)} < ${gates.balanced_min} → STRICT / reconcile`,
    );
  } else if (
    confidence < gates.fast_min &&
    PROFILE_RANK[next] < PROFILE_RANK.balanced
  ) {
    next = "balanced";
    reasons.push(
      `confidence ${confidence.toFixed(2)} < ${gates.fast_min} → BALANCED minimum`,
    );
  }
  return next;
}

function classifyStage(input = {}) {
  return input.classification_stage || input.stage || "pre-implementation";
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
  const stage = classifyStage(input);
  let confidence = 0.7;

  const profileOverride = profileOverrideFor(input);
  const files = nonNegativeNumber(input.filesChanged ?? input.files_changed);
  const lines = nonNegativeNumber(
    input.estimatedLines ?? input.estimated_lines,
  );
  const changeClass =
    input.changeClass || input.change_class || "small-feature-with-tests";
  const evidence = evidenceForInput(input, files, lines);
  const evidenceSource = describeEvidenceSource(
    input,
    evidence,
    files,
    reasons,
  );
  const flags = collectFlags(input, evidence, reasons);
  const quality = assessEvidenceQuality(input, stage);

  if (quality.uncertainty_factors.length) {
    for (const factor of quality.uncertainty_factors) {
      reasons.push(`Uncertainty: ${factor}`);
    }
  }

  const hardHit = (rules.hard_strict_triggers || []).filter((t) =>
    flags.has(t),
  );
  if (hardHit.length) {
    reasons.push(`Hard strict trigger(s): ${hardHit.join(", ")}`);
    if (profileOverride) {
      reasons.push(
        `Explicit profile override ${profileOverride} cannot downgrade hard strict work; preserving strict`,
      );
    }
    confidence = quality.evidence_quality === "unknown" ? 0.9 : 0.95;
    return finalize({
      profile: "strict",
      review_level: "dual",
      risk_score: Math.max(rules.thresholds.strict_min, 6 + hardHit.length),
      confidence,
      reasons,
      changeClass,
      flags,
      rules,
      input,
      hard_triggers: hardHit,
      stage,
      evidence_quality: quality.evidence_quality,
      uncertainty_factors: quality.uncertainty_factors,
      graphify: graphifySignalsFrom(input),
    });
  }

  const scored = scoreSemanticRisk(input, flags, files, lines, rules, reasons);
  let { risk_score } = scored;

  if (flags.has("documentation") || flags.has("formatting")) {
    confidence = Math.max(confidence, 0.9);
    if (files <= 2 && lines <= 50 && !flags.has("exported_symbol_change")) {
      reasons.push("Documentation/formatting change");
    }
  }

  const tinyInternal = tinyInternalEvidence(flags, changeClass, files, lines);
  if (tinyInternal && risk_score <= rules.thresholds.fast_max) {
    reasons.push("Tiny internal / docs change under fast thresholds");
    confidence = Math.max(confidence, 0.88);
  } else if (risk_score === 0 && files <= 2 && lines <= 50) {
    risk_score += 2;
    reasons.push("Ordinary change without tiny-internal markers → not fast");
    confidence = Math.max(confidence, 0.75);
  }

  if (input.existingFocusedTests) {
    reasons.push("Existing focused tests found");
    confidence = Math.min(1, confidence + 0.05);
  }
  if (evidenceSource === "git-diff" && input.diff_available === true) {
    confidence = Math.min(1, confidence + 0.05);
  }
  if (
    scored.graphify.direct_callers != null &&
    scored.graphify.direct_callers <=
      (rules.caller_thresholds?.low_direct ?? 1) &&
    quality.evidence_quality !== "unknown"
  ) {
    confidence = Math.min(1, confidence + 0.05);
  }
  if (quality.evidence_quality === "trusted") {
    confidence = Math.min(1, confidence + 0.07);
  }
  if (quality.evidence_quality === "unknown") {
    confidence = Math.min(confidence, 0.7);
    reasons.push("Unknown evidence caps confidence; FAST is unavailable");
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

  const gates = rules.confidence_gates || DEFAULT_V2.confidence_gates;
  profile = applyConfidenceGates(
    profile,
    confidence,
    quality.evidence_quality,
    gates,
    reasons,
  );

  if (profileOverride) {
    if (!rules.allowExplicitOverride) {
      reasons.push(
        `Explicit profile override ignored by workflow policy: ${profileOverride}`,
      );
    } else if (PROFILE_RANK[profileOverride] < PROFILE_RANK[profile]) {
      reasons.push(
        `Explicit profile override ${profileOverride} cannot downgrade computed ${profile}; preserving ${profile}`,
      );
    } else {
      profile = profileOverride;
      reasons.push(`Explicit profile override: ${profileOverride}`);
    }
  }

  if (input.prior_profile) {
    profile = maxProfile(input.prior_profile, profile);
  }

  const review_level = reviewLevelFor(
    profile,
    changeClass,
    reviewMatrix,
    flags,
    rules,
  );
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
    stage,
    evidence_quality: quality.evidence_quality,
    uncertainty_factors: quality.uncertainty_factors,
    graphify: scored.graphify,
  });
}

function uniqueReasons(reasons) {
  const seen = new Set();
  const out = [];
  for (const reason of reasons) {
    const key = String(reason);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
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
  stage = "pre-implementation",
  evidence_quality = "partial",
  uncertainty_factors = [],
  graphify = {},
}) {
  const dp = rules.direct_path;
  const allowedClass =
    dp.allowed_classes.includes(changeClass) ||
    flags.has("documentation") ||
    flags.has("formatting") ||
    flags.has("one_file_internal");

  const files = nonNegativeNumber(input.filesChanged ?? input.files_changed);
  const lines = nonNegativeNumber(
    input.estimatedLines ?? input.estimated_lines,
  );
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

  const authoritativeDiffEvidence =
    evidenceSource === "git-diff" &&
    input.diff_verified === true &&
    input.diff_available === true &&
    input.diff_clean !== true;

  const unknownBlocksDirect = evidence_quality === "unknown";
  const gates = rules.confidence_gates || DEFAULT_V2.confidence_gates;

  const direct_eligible =
    !userForbidsDirect &&
    authoritativeDiffEvidence &&
    profile !== "strict" &&
    !diffEvidenceIsNotDirectSafe &&
    !unknownBlocksDirect &&
    confidence >= gates.fast_min &&
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
    reasons.push(
      "Direct path denied: strict profile requires delegated review",
    );
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
  if (!direct_eligible && unknownBlocksDirect) {
    reasons.push(
      "Direct path denied: unknown/stale evidence cannot authorize direct execution",
    );
  }

  let finalReview = review_level;
  if (input.prior_review_level) {
    finalReview = maxReview(finalReview, input.prior_review_level);
  }
  if (
    execution_mode === "direct" &&
    (changeClass === "documentation" || changeClass === "formatting")
  ) {
    finalReview = "none";
  }

  let finalExecution = execution_mode;
  if (input.prior_execution_mode) {
    finalExecution = maxExecution(finalExecution, input.prior_execution_mode);
  }

  return {
    schema_version: "1.0",
    stage,
    profile,
    review_level: finalReview,
    execution_mode: finalExecution,
    risk_score,
    confidence: Number(confidence.toFixed(2)),
    evidence_quality,
    uncertainty_factors,
    reasons: uniqueReasons(reasons),
    direct_eligible: direct_eligible && finalExecution === "direct",
    change_class: changeClass,
    hard_triggers,
    semantic_signals: [...flags].sort(),
    graphify: {
      direct_callers: graphify.direct_callers ?? null,
      transitive_impact: graphify.transitive_impact ?? null,
      affected_packages: graphify.affected_packages || [],
    },
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

function priorInputFrom(previous = {}) {
  const evidence = previous.evidence || {};
  return {
    filesChanged: evidence.files_changed ?? previous.files_changed,
    estimatedLines: evidence.estimated_lines ?? previous.estimated_lines,
    changeClass: previous.change_class,
    changed_files: previous.changed_files || evidence.changed_files,
    added_lines: previous.added_lines ?? evidence.added_lines,
    deleted_lines: previous.deleted_lines ?? evidence.deleted_lines,
    changed_lines: evidence.changed_lines,
    changed_exported_symbols:
      previous.changed_exported_symbols || evidence.changed_exported_symbols,
    changed_test_files:
      previous.changed_test_files || evidence.changed_test_files,
    package_boundaries:
      previous.package_boundaries || evidence.package_boundaries,
    workspace_boundaries:
      previous.workspace_boundaries || evidence.workspace_boundaries,
    flags: previous.semantic_signals || previous.flags,
    evidence_source: previous.evidence_source,
    diff_verified: previous.diff_verified,
    diff_available: previous.diff_available,
    diff_clean: previous.diff_clean,
    focusedValidation:
      Array.isArray(previous.semantic_signals) &&
      previous.semantic_signals.includes("focused_validation"),
  };
}

/**
 * Post-blast reclassification. Never weakens the previous profile, review
 * level, or execution mode. HIGH blast escalates review independently of the
 * execution profile.
 */
export function reclassifyAfterBlast(
  previous = {},
  blastReport = {},
  options = {},
) {
  const input = {
    ...priorInputFrom(previous),
    blast: blastReport,
    graph: options.graph,
    graphify: options.graphify,
    classification_stage: "post-blast",
    prior_profile: previous.profile,
    prior_review_level: previous.review_level,
    prior_execution_mode: previous.execution_mode,
  };
  if (options.directCallers != null)
    input.directCallers = options.directCallers;
  if (options.graph_stale === true) input.graph_stale = true;
  const result = classify(input, options);
  const rules =
    options.workflowConfig?.classificationRules ||
    options.rules ||
    loadClassificationRules(options.profilesPath);

  let profile = maxProfile(previous.profile, result.profile);
  let review_level = maxReview(previous.review_level, result.review_level);
  let execution_mode = maxExecution(
    previous.execution_mode,
    result.execution_mode,
  );
  const reasons = [...result.reasons];

  const risk = blastRiskOf(blastReport);
  if (risk === "HIGH") {
    if (rules.escalateReviewOnHighBlast !== false) {
      review_level = maxReview(review_level, "dual");
      reasons.push("HIGH blast discovered later → dual review");
    }
    profile = maxProfile(profile, "balanced");
    execution_mode = maxExecution(execution_mode, "delegated");
    if (rules.escalateToStrictOnHighBlast === true) {
      profile = maxProfile(profile, "strict");
      reasons.push("HIGH blast policy escalateToStrictOnHighBlast");
    }
  }
  if (
    isUnknownBlastEvidence(blastReport) ||
    result.evidence_quality === "unknown"
  ) {
    if (profile === "fast") {
      profile = "balanced";
      reasons.push("UNKNOWN blast/graph evidence cannot remain FAST");
    }
    execution_mode = maxExecution(execution_mode, "delegated");
  }

  return {
    ...result,
    stage: "post-blast",
    profile,
    review_level,
    execution_mode,
    direct_eligible: false,
    reasons: uniqueReasons(reasons),
    prior_profile: previous.profile || null,
    prior_review_level: previous.review_level || null,
  };
}

export { DEFAULT_V2, DEFAULT_PROFILES, PROFILE_RANK, REVIEW_RANK };
