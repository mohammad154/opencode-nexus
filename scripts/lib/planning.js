/**
 * Planning-only policy helpers.
 *
 * Planning advice is deliberately separate from the execution state machine:
 * the advisor can challenge a plan, but it cannot authorize a transition or
 * write production code.
 */

export const PLANNING_MODES = Object.freeze(["compact", "standard", "deep"]);

/**
 * Deterministic semantic signals that drive planning depth and the plan-advisor
 * decision. These replace file-count dominance: a one-line authentication
 * change is not "small", and a three-file cohesive feature is not "large".
 */
export const PLANNING_SIGNALS = Object.freeze([
  "PUBLIC_CONTRACT",
  "SECURITY_BOUNDARY",
  "MIGRATION",
  "DESTRUCTIVE_CHANGE",
  "ARCHITECTURAL_CHOICE",
  "MULTI_SUBSYSTEM",
  "UNRESOLVED_DECISION",
  "HIGH_IMPACT",
  "UNKNOWN_IMPACT",
]);

/**
 * Signals that additionally require deep planning. `ARCHITECTURAL_CHOICE`,
 * `MULTI_SUBSYSTEM`, and `UNRESOLVED_DECISION` are deliberately absent: they
 * require an independent challenge, not necessarily deeper decomposition.
 */
const DEEP_PLANNING_SIGNALS = Object.freeze([
  "PUBLIC_CONTRACT",
  "SECURITY_BOUNDARY",
  "MIGRATION",
  "DESTRUCTIVE_CHANGE",
  "HIGH_IMPACT",
  "UNKNOWN_IMPACT",
]);

/** Every semantic signal disqualifies compact planning. */
const COMPACT_DISQUALIFYING_SIGNALS = PLANNING_SIGNALS;

/**
 * Review-surface ceilings for compact planning. Size is a signal, not the
 * deciding rule: staying under these bounds is necessary but not sufficient.
 */
export const COMPACT_MAX_FILES = 5;
export const COMPACT_MAX_LINES = 150;

const SIGNAL_PATTERNS = Object.freeze([
  [
    "PUBLIC_CONTRACT",
    /public[-_. ]?api|public[-_. ]?contract|wire[-_. ]?(format|protocol)|\bprotocol\b|\bschema\b|\bendpoint\b|breaking[-_. ]?change|backward[-_. ]?compat|\bserializ/i,
  ],
  [
    "SECURITY_BOUNDARY",
    /\bsecurity\b|\bauth\b|\bauthn\b|\bauthz\b|authent|authoriz|credential|\bsecret\b|\btoken\b|permission|\bcrypto|password|\bsession\b|\btenant\b|\bsandbox\b/i,
  ],
  ["MIGRATION", /migration|\bmigrate|backfill|upgrade[-_. ]?path|data[-_. ]?move|reindex/i],
  [
    "DESTRUCTIVE_CHANGE",
    /destructive|\bdelete\b|\bdrop\b|truncate|\bpurge\b|irreversible|force[-_. ]?push|\bwipe\b/i,
  ],
  [
    "ARCHITECTURAL_CHOICE",
    /architect|\brefactor|redesign|\brewrite\b|framework[-_. ]?choice|design[-_. ]?decision|\btradeoff/i,
  ],
  [
    "MULTI_SUBSYSTEM",
    /multi[-_. ]?subsystem|cross[-_. ]?cutting|cross[-_. ]?(service|module|package)|\bsystem[-_. ]?wide/i,
  ],
  [
    "UNRESOLVED_DECISION",
    /unresolved|undecided|ambiguous|\btbd\b|open[-_. ]?question|\bunclear\b|needs[-_. ]?decision/i,
  ],
]);

const SIGNAL_FLAGS = Object.freeze([
  ["PUBLIC_CONTRACT", ["public_contract", "publicContract", "public_api", "wire_change"]],
  [
    "SECURITY_BOUNDARY",
    ["security_boundary", "securityBoundary", "security_sensitive", "auth_change"],
  ],
  ["MIGRATION", ["migration", "is_migration", "requires_migration"]],
  ["DESTRUCTIVE_CHANGE", ["destructive", "destructive_change", "destructiveChange"]],
  [
    "ARCHITECTURAL_CHOICE",
    ["architectural_choice", "architecturalChoice", "architecture_decision"],
  ],
  ["MULTI_SUBSYSTEM", ["multi_subsystem", "multiSubsystem", "cross_subsystem"]],
  [
    "UNRESOLVED_DECISION",
    ["unresolved_decision", "unresolvedDecision", "open_decision", "decision_pending"],
  ],
]);

function numericOrLength(value) {
  return Array.isArray(value) ? value.length : Number(value);
}

function firstDefined(input, keys) {
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function stringList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry ?? ""));
  if (value == null || value === "") return [];
  return [String(value)];
}

function normalizeSignalName(value) {
  const name = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[-. ]/g, "_");
  return PLANNING_SIGNALS.includes(name) ? name : null;
}

export function normalizePlanningMode(value, fallback = "standard") {
  const mode = String(value ?? "").trim().toLowerCase();
  return PLANNING_MODES.includes(mode) ? mode : fallback;
}

function planningRisk(input) {
  return String(
    firstDefined(input, ["risk", "impact_risk", "blastRisk", "blast_risk"]) ?? "",
  )
    .trim()
    .toUpperCase();
}

/**
 * Derive the semantic signals present in planning evidence.
 *
 * Matching is bounded and deterministic: declared signal names, explicit
 * booleans, the change class, hard triggers, and the stated objective. It never
 * inspects free-form conversation, so the same evidence always yields the same
 * signals. False positives escalate planning, which is the safe direction.
 */
export function detectPlanningSignals(input = {}) {
  const found = new Set();

  for (const declared of stringList(
    firstDefined(input, [
      "semantic_signals",
      "semanticSignals",
      "planning_signals",
      "planningSignals",
      "signals",
    ]),
  )) {
    const name = normalizeSignalName(declared);
    if (name) found.add(name);
  }

  for (const [signal, flags] of SIGNAL_FLAGS) {
    if (flags.some((flag) => input[flag] === true)) found.add(signal);
  }

  const corpus = [
    ...stringList(firstDefined(input, ["change_class", "changeClass", "class"])),
    ...stringList(firstDefined(input, ["hard_triggers", "hardSignals", "hardTriggers"])),
    ...stringList(firstDefined(input, ["objective", "summary"])),
  ].join(" ");
  if (corpus.trim()) {
    for (const [signal, pattern] of SIGNAL_PATTERNS) {
      if (pattern.test(corpus)) found.add(signal);
    }
  }

  const subsystems = numericOrLength(
    firstDefined(input, ["subsystems", "subsystem_count", "subsystemCount"]),
  );
  if (Number.isFinite(subsystems) && subsystems > 1) found.add("MULTI_SUBSYSTEM");

  const openQuestions = numericOrLength(
    firstDefined(input, [
      "open_questions",
      "openQuestions",
      "unresolved_decisions",
      "unresolvedDecisions",
    ]),
  );
  if (Number.isFinite(openQuestions) && openQuestions > 0) {
    found.add("UNRESOLVED_DECISION");
  }

  const risk = planningRisk(input);
  if (risk === "HIGH" || risk === "CRITICAL") found.add("HIGH_IMPACT");
  // An absent risk is "not measured yet" (impact runs after planning), not
  // "unknown". Only an explicitly inconclusive measurement escalates.
  if (risk === "UNKNOWN") found.add("UNKNOWN_IMPACT");

  return PLANNING_SIGNALS.filter((signal) => found.has(signal));
}

function truthy(input, keys) {
  return keys.some((key) => input[key] === true);
}

function planningSizes(input) {
  return {
    files: numericOrLength(
      firstDefined(input, ["files_changed", "filesChanged", "file_count", "fileCount"]),
    ),
    lines: numericOrLength(
      firstDefined(input, ["estimated_lines", "estimatedLines", "lines"]),
    ),
    units: numericOrLength(
      firstDefined(input, [
        "unit_count",
        "unitCount",
        "execution_units",
        "tasks",
        "units",
      ]),
    ),
  };
}

const TRIVIAL_CLASS = /^(rename|typo|docs?|documentation|format|tiny|comment)/i;

/**
 * Decide whether compact planning is admissible.
 *
 * Compact requires positive evidence of cohesion, not merely the absence of
 * escalation signals: an unclassified change is planned as `standard`. Agent
 * claims can therefore only lower planning depth when no deterministic signal
 * fires — they can never override one.
 */
export function compactEligibility(input = {}) {
  const signals = Array.isArray(input.__signals)
    ? input.__signals
    : detectPlanningSignals(input);
  const blocking = signals.filter((signal) =>
    COMPACT_DISQUALIFYING_SIGNALS.includes(signal),
  );
  const { files, lines, units } = planningSizes(input);
  const risk = planningRisk(input);
  const changeClass = String(
    firstDefined(input, ["change_class", "changeClass", "class"]) ?? "",
  );
  const reasons = [];

  if (blocking.length > 0) {
    return { eligible: false, reason_codes: blocking.slice(), blocking_signals: blocking };
  }

  if (Number.isFinite(units) && units > 1) {
    return {
      eligible: false,
      reason_codes: ["MULTIPLE_EXECUTION_UNITS"],
      blocking_signals: [],
    };
  }
  if (Number.isFinite(files) && files > COMPACT_MAX_FILES) {
    return { eligible: false, reason_codes: ["REVIEW_SURFACE_TOO_LARGE"], blocking_signals: [] };
  }
  if (Number.isFinite(lines) && lines > COMPACT_MAX_LINES) {
    return { eligible: false, reason_codes: ["REVIEW_SURFACE_TOO_LARGE"], blocking_signals: [] };
  }

  // Path 1: a trivially small or purely mechanical change.
  if (
    (Number.isFinite(files) && files <= 1 && Number.isFinite(lines) && lines <= 20) ||
    TRIVIAL_CLASS.test(changeClass)
  ) {
    return {
      eligible: true,
      reason_codes: ["TRIVIAL_CHANGE_SURFACE"],
      blocking_signals: [],
    };
  }

  // Path 2: declared cohesion plus an established pattern plus known impact.
  const cohesive =
    truthy(input, ["cohesive_unit", "cohesiveUnit", "single_cohesive_unit"]) ||
    (Number.isFinite(units) && units === 1);
  const knownPattern =
    truthy(input, ["known_pattern", "knownPattern", "established_pattern"]) ||
    /^(known|established|existing)$/i.test(
      String(firstDefined(input, ["implementation_pattern", "implementationPattern"]) ?? ""),
    );
  const impactKnown = risk === "LOW" || risk === "MEDIUM" || risk === "NONE";

  if (cohesive) reasons.push("SINGLE_COHESIVE_UNIT");
  if (knownPattern) reasons.push("KNOWN_IMPLEMENTATION_PATTERN");
  if (impactKnown) reasons.push("IMPACT_NOT_HIGH");

  if (cohesive && knownPattern && impactKnown) {
    return { eligible: true, reason_codes: reasons, blocking_signals: [] };
  }

  const missing = [];
  if (!cohesive) missing.push("COHESION_UNDECLARED");
  if (!knownPattern) missing.push("IMPLEMENTATION_PATTERN_UNDECLARED");
  if (!impactKnown) missing.push("IMPACT_NOT_MEASURED");
  return { eligible: false, reason_codes: missing, blocking_signals: [] };
}

/**
 * Infer planning depth from observable request evidence. Explicit mode wins.
 *
 * Depth follows semantic risk first and size second. A large but mechanical
 * change can still be standard; a one-line security change cannot be compact.
 */
export function inferPlanningMode(input = {}) {
  if (input.planning_mode || input.planningMode) {
    return normalizePlanningMode(input.planning_mode || input.planningMode);
  }

  const signals = detectPlanningSignals(input);
  const { files, lines, units } = planningSizes(input);

  if (
    signals.some((signal) => DEEP_PLANNING_SIGNALS.includes(signal)) ||
    (Number.isFinite(files) && files > 8) ||
    (Number.isFinite(lines) && lines > 400) ||
    (Number.isFinite(units) && units > 5)
  ) {
    return "deep";
  }

  if (compactEligibility({ ...input, __signals: signals }).eligible) return "compact";

  return "standard";
}

/**
 * Return an inferred mode only when the caller supplied planning evidence.
 * This keeps compatibility callers with no classification metadata on the
 * compact path while allowing the orchestrator to adapt from risk/size data.
 */
export function planningModeFromEvidence(input = {}) {
  const explicit = input.planning_mode || input.planningMode;
  if (explicit) return normalizePlanningMode(explicit);

  const filesInput =
    input.files_changed ?? input.filesChanged ?? input.file_count;
  const files = Array.isArray(filesInput) ? filesInput.length : filesInput;
  const lines = input.estimated_lines ?? input.estimatedLines ?? input.lines;
  const unitsInput =
    input.unit_count ??
    input.unitCount ??
    input.execution_units ??
    input.tasks ??
    input.units;
  const unitCount = Array.isArray(unitsInput) ? unitsInput.length : unitsInput;
  const risk = input.risk || input.impact_risk || input.blastRisk;
  const changeClass = input.change_class || input.changeClass || input.class;
  const hasNumber = (value) =>
    Array.isArray(value)
      ? value.length > 0
      : value != null && value !== "" && Number.isFinite(Number(value));
  const hasEvidence =
    Boolean(String(risk || "").trim()) ||
    Boolean(String(changeClass || "").trim()) ||
    (Array.isArray(input.hard_triggers) && input.hard_triggers.length > 0) ||
    (Array.isArray(input.hardSignals) && input.hardSignals.length > 0) ||
    (Array.isArray(filesInput) ? filesInput.length > 0 : hasNumber(files)) ||
    hasNumber(lines) ||
    (Array.isArray(unitsInput)
      ? unitsInput.length > 0
      : hasNumber(unitCount));
  if (!hasEvidence) return null;

  return inferPlanningMode({
    ...input,
    files_changed: Number(files),
    estimated_lines: Number(lines),
    unit_count: Number(unitCount),
  });
}

export const PLAN_ADVISOR_DECISION_VERSION = "nexus-plan-advisor-decision/1";

/**
 * Signals that make an independent planning challenge mandatory. These are hard
 * safety triggers: an orchestrator-supplied confidence claim cannot clear them.
 */
const ADVISOR_HARD_TRIGGER_SIGNALS = Object.freeze([
  "PUBLIC_CONTRACT",
  "SECURITY_BOUNDARY",
  "MIGRATION",
  "DESTRUCTIVE_CHANGE",
  "ARCHITECTURAL_CHOICE",
  "MULTI_SUBSYSTEM",
  "HIGH_IMPACT",
  "UNKNOWN_IMPACT",
]);

/**
 * Decide whether an independent plan-advisor challenge is required.
 *
 * Planning depth and independent challenge are separate variables: a clear
 * `standard` unit may legitimately need no advisor, while an explicitly
 * compact-looking change that touches an auth boundary always does.
 *
 * Precedence is strictly:
 *   1. deterministic hard safety trigger  → REQUIRED
 *   2. explicit meaningful uncertainty    → REQUIRED
 *   3. insufficient evidence to judge     → REQUIRED (fail closed)
 *   4. clear, cohesive, low-risk task     → NOT REQUIRED
 *
 * Deep planning always keeps one advisor call for now.
 */
export function planAdvisorDecision(input = {}) {
  const signals = Array.isArray(input.__signals)
    ? input.__signals
    : detectPlanningSignals(input);
  const explicitMode = input.planning_mode || input.planningMode;
  const mode = explicitMode
    ? normalizePlanningMode(explicitMode)
    : inferPlanningMode({ ...input, __signals: signals });

  const hardTriggers = signals.filter((signal) =>
    ADVISOR_HARD_TRIGGER_SIGNALS.includes(signal),
  );
  if (mode === "deep") hardTriggers.push("DEEP_PLANNING_DEPTH");

  if (hardTriggers.length > 0) {
    return {
      required: true,
      reason_codes: hardTriggers,
      signals,
      planning_mode: mode,
      precedence: "hard_trigger",
      version: PLAN_ADVISOR_DECISION_VERSION,
    };
  }

  const uncertainty = [];
  if (signals.includes("UNRESOLVED_DECISION")) uncertainty.push("UNRESOLVED_DECISION");
  if (
    truthy(input, [
      "decomposition_uncertain",
      "decompositionUncertain",
      "decomposition_unclear",
    ])
  ) {
    uncertainty.push("DECOMPOSITION_UNCERTAIN");
  }
  if (
    truthy(input, [
      "planning_uncertainty",
      "planningUncertainty",
      "request_plan_advisor",
      "advisor_requested",
    ])
  ) {
    uncertainty.push("EXPLICIT_PLANNING_UNCERTAINTY");
  }
  if (uncertainty.length > 0) {
    return {
      required: true,
      reason_codes: uncertainty,
      signals,
      planning_mode: mode,
      precedence: "explicit_uncertainty",
      version: PLAN_ADVISOR_DECISION_VERSION,
    };
  }

  const compact = compactEligibility({ ...input, __signals: signals });
  const { units } = planningSizes(input);
  const risk = planningRisk(input);
  const cohesive =
    compact.eligible ||
    truthy(input, ["cohesive_unit", "cohesiveUnit", "single_cohesive_unit"]) ||
    (Number.isFinite(units) && units === 1);
  const knownPattern =
    truthy(input, ["known_pattern", "knownPattern", "established_pattern"]) ||
    /^(known|established|existing)$/i.test(
      String(firstDefined(input, ["implementation_pattern", "implementationPattern"]) ?? ""),
    );

  // Compact planning never spends an advisor call.
  if (mode === "compact") {
    return {
      required: false,
      reason_codes: [
        "COMPACT_PLANNING",
        ...compact.reason_codes,
        "NO_HARD_TRIGGER",
        "NO_EXPLICIT_UNCERTAINTY",
      ],
      signals,
      planning_mode: mode,
      precedence: "compact_planning",
      version: PLAN_ADVISOR_DECISION_VERSION,
    };
  }

  // Without positive evidence of a cohesive, understood task there is nothing
  // to prove the challenge unnecessary, so it stays required.
  if (!cohesive || !knownPattern) {
    const missing = [];
    if (!cohesive) missing.push("COHESION_UNDECLARED");
    if (!knownPattern) missing.push("IMPLEMENTATION_PATTERN_UNDECLARED");
    return {
      required: true,
      reason_codes: ["INSUFFICIENT_PLANNING_EVIDENCE", ...missing],
      signals,
      planning_mode: mode,
      precedence: "insufficient_evidence",
      version: PLAN_ADVISOR_DECISION_VERSION,
    };
  }

  const reasons = ["SINGLE_COHESIVE_UNIT", "KNOWN_IMPLEMENTATION_PATTERN"];
  if (!signals.includes("ARCHITECTURAL_CHOICE")) reasons.push("NO_ARCHITECTURAL_CHOICE");
  if (risk === "LOW" || risk === "MEDIUM" || risk === "NONE") {
    reasons.push("IMPACT_NOT_HIGH");
  } else {
    // Disclosed, not hidden: impact normally runs after planning.
    reasons.push("IMPACT_UNMEASURED_AT_PLANNING");
  }
  reasons.push("NO_HARD_TRIGGER", "NO_EXPLICIT_UNCERTAINTY");

  return {
    required: false,
    reason_codes: reasons,
    signals,
    planning_mode: mode,
    precedence: "cohesive_task",
    version: PLAN_ADVISOR_DECISION_VERSION,
  };
}

/**
 * Read a persisted decision. A decision without an explicit boolean `required`
 * and at least one reason code is not a decision, so it is discarded rather
 * than trusted as `required: false`.
 */
export function normalizePlanAdvisorDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.required !== "boolean") return null;
  const codes = Array.isArray(value.reason_codes)
    ? value.reason_codes.map((code) => String(code)).filter(Boolean)
    : [];
  if (codes.length === 0) return null;
  return {
    required: value.required,
    reason_codes: codes,
    signals: Array.isArray(value.signals)
      ? value.signals.map((signal) => String(signal)).filter(Boolean)
      : [],
    planning_mode: value.planning_mode ? normalizePlanningMode(value.planning_mode) : null,
    precedence: value.precedence ? String(value.precedence) : null,
    version: value.version ? String(value.version) : null,
  };
}

/**
 * Whether a plan-advisor call is needed.
 *
 * Accepts a planning mode (compatibility: any non-compact mode is conservative
 * and returns true) or full planning evidence, which enables the deterministic
 * uncertainty-driven decision.
 */
export function shouldInvokePlanAdvisor(modeOrEvidence, options = {}) {
  if (modeOrEvidence && typeof modeOrEvidence === "object") {
    return planAdvisorDecision(modeOrEvidence).required;
  }
  const decision = normalizePlanAdvisorDecision(options.decision);
  if (decision) return decision.required;
  return normalizePlanningMode(modeOrEvidence) !== "compact";
}

/**
 * Canonical advisor call envelope.
 *
 * A persisted decision is authoritative when present; otherwise the mode-only
 * fallback stays conservative (any non-compact mode reserves one call), because
 * absent evidence must never be read as "no challenge needed".
 */
export function planAdvisorCallCount(
  mode,
  { criticalDisagreement = false, decision = null } = {},
) {
  const normalized = normalizePlanningMode(mode);
  const persisted = normalizePlanAdvisorDecision(decision);
  const required = persisted
    ? persisted.required
    : shouldInvokePlanAdvisor(normalized);
  if (!required) return 0;
  return normalized === "deep" && criticalDisagreement ? 2 : 1;
}

const KNOWN_MODEL_FAMILIES = [
  ["gpt", /^gpt(?:[-_.]|$)/i],
  ["claude", /^claude(?:[-_.]|$)/i],
  ["gemini", /^gemini(?:[-_.]|$)/i],
  ["deepseek", /^deepseek(?:[-_.]|$)/i],
  ["minimax", /^minimax(?:[-_.]|$)/i],
  ["qwen", /^qwen(?:[-_.]|$)/i],
  ["llama", /^llama(?:[-_.]|$)/i],
  ["mistral", /^mistral(?:[-_.]|$)/i],
];

/** Return the provider-independent family portion of a model identifier. */
export function modelFamily(model) {
  const identifier = String(model || "").trim().split("/").pop();
  if (!identifier) return null;
  const known = KNOWN_MODEL_FAMILIES.find(([, pattern]) => pattern.test(identifier));
  return known ? known[0] : identifier.split(/[-_.]/)[0].toLowerCase();
}

function modelProviderNamespace(model) {
  const value = String(model || "").trim();
  if (!value) return null;
  return value.includes("/") ? value.split("/")[0].toLowerCase() : null;
}

/**
 * Configuration guard used by the installer/doctor and by transition callers.
 * Missing model names are not treated as equal: providers may inject the
 * effective model later, but an explicit collision is always rejected.
 */
export function validatePlanAdvisorModelDiversity({
  orchestratorModel,
  planAdvisorModel,
} = {}) {
  const orchestrator = String(orchestratorModel || "").trim();
  const advisor = String(planAdvisorModel || "").trim();
  if (!orchestrator || !advisor) {
    return { ok: true, warning: "model identity unavailable for comparison" };
  }
  if (orchestrator === advisor) {
    return {
      ok: false,
      error: "orchestrator.model must differ from plan-advisor.model",
    };
  }
  const orchestratorFamily = modelFamily(orchestrator);
  const advisorFamily = modelFamily(advisor);
  const orchestratorProvider = modelProviderNamespace(orchestrator);
  const advisorProvider = modelProviderNamespace(advisor);
  return {
    ok: true,
    different_family: orchestratorFamily !== advisorFamily,
    different_provider_namespace: orchestratorProvider !== advisorProvider,
    orchestrator_family: orchestratorFamily,
    plan_advisor_family: advisorFamily,
    warning:
      orchestratorFamily === advisorFamily
        ? "orchestrator and plan-advisor use the same model family"
        : null,
  };
}
