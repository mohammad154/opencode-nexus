/**
 * Planning-only policy helpers.
 *
 * Planning advice is deliberately separate from the execution state machine:
 * the advisor can challenge a plan, but it cannot authorize a transition or
 * write production code.
 */

export const PLANNING_MODES = Object.freeze(["compact", "standard", "deep"]);

function numericOrLength(value) {
  return Array.isArray(value) ? value.length : Number(value);
}

export function normalizePlanningMode(value, fallback = "standard") {
  const mode = String(value ?? "").trim().toLowerCase();
  return PLANNING_MODES.includes(mode) ? mode : fallback;
}

/**
 * Infer planning depth from observable request evidence. Explicit mode wins.
 * This is intentionally conservative: uncertainty increases planning depth,
 * while only a genuinely tiny, single-file change gets compact planning.
 */
export function inferPlanningMode(input = {}) {
  if (input.planning_mode || input.planningMode) {
    return normalizePlanningMode(input.planning_mode || input.planningMode);
  }

  const risk = String(
    input.risk || input.impact_risk || input.blastRisk || "",
  ).toUpperCase();
  const changeClass = String(
    input.change_class || input.changeClass || input.class || "",
  ).toLowerCase();
  const hardSignals = Array.isArray(input.hard_triggers)
    ? input.hard_triggers
    : Array.isArray(input.hardSignals)
      ? input.hardSignals
      : [];
  const files = numericOrLength(
    input.files_changed ?? input.filesChanged ?? input.file_count,
  );
  const lines = numericOrLength(
    input.estimated_lines ?? input.estimatedLines ?? input.lines,
  );
  const unitCount = numericOrLength(
    input.unit_count ??
      input.unitCount ??
      input.execution_units ??
      input.tasks ??
      input.units,
  );

  const deepTerms = /(migration|refactor|architecture|security|credential|public.?api|database)/i;
  if (
    ["HIGH", "CRITICAL", "UNKNOWN"].includes(risk) ||
    deepTerms.test(changeClass) ||
    hardSignals.some((signal) => deepTerms.test(String(signal))) ||
    (Number.isFinite(files) && files > 8) ||
    (Number.isFinite(lines) && lines > 400) ||
    (Number.isFinite(unitCount) && unitCount > 5)
  ) {
    return "deep";
  }

  if (
    (Number.isFinite(files) && files <= 1 &&
      Number.isFinite(lines) && lines <= 20) ||
    /^(rename|typo|docs?|documentation|format|tiny)/i.test(changeClass)
  ) {
    return "compact";
  }

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

export function shouldInvokePlanAdvisor(mode) {
  return normalizePlanningMode(mode) !== "compact";
}

export function planAdvisorCallCount(
  mode,
  { criticalDisagreement = false } = {},
) {
  const normalized = normalizePlanningMode(mode);
  if (!shouldInvokePlanAdvisor(normalized)) return 0;
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
