import fs from "node:fs";
import path from "node:path";
import { buildTaskDag, detectCycle, scheduleParallel } from "./task-dag.js";
import { globsOverlap } from "./impact/boundaries.js";
import { estimateAgentCalls } from "./agent-estimate.js";
import { inferPlanningMode, normalizePlanningMode } from "./planning.js";

const GENERIC_TITLE_WORDS = new Set([
  "add",
  "change",
  "create",
  "fix",
  "implement",
  "make",
  "update",
  "unit",
  "task",
  "the",
  "and",
  "for",
  "with",
]);

function clean(value) {
  return String(value ?? "").replace(/\r$/, "").trim();
}

function unquote(value) {
  return clean(value).replace(/^['"]|['"]$/g, "");
}

function scalarAfter(lines, pattern) {
  const line = lines.find((candidate) => pattern.test(candidate));
  if (!line) return null;
  return unquote(line.replace(pattern, ""));
}

function parseNumber(value) {
  const match = String(value ?? "").match(/\b(\d+)\b/);
  return match ? Number(match[1]) : null;
}

function splitValues(value) {
  const text = clean(value);
  if (!text || /^none$/i.test(text)) return [];
  const values = text
    .replace(/\band\b/gi, ",")
    .split(/[,;|]/)
    .map((part) => part.replace(/^[-*]\s*/, "").trim())
    .filter((part) => part && !/^none$/i.test(part));
  return values.length > 0 ? values : [text];
}

function extractPathTokens(value) {
  const text = clean(value);
  const quoted = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const source = quoted.length > 0 ? quoted : splitValues(text);
  return source
    .map((item) => item.replace(/^\*\s*/, "").trim())
    .map((item) => item.replace(/\s+–.*$/, "").replace(/\s+-\s+.*$/, ""))
    .filter(
      (item) =>
        item &&
        !/^<|^path\/to|^files that|^list from|^the /i.test(item) &&
        /[./\\*]/.test(item),
    )
    .map((item) => item.replace(/^[./]+(?=[A-Za-z])/, ""));
}

function headingSections(lines) {
  const matches = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(
      /^###\s+(?:Execution\s+Unit|Task)\s+(?:\d+|[A-Za-z0-9._-]+)\s*:\s*(.+)$/i,
    );
    if (match) matches.push({ index: i, title: clean(match[1]) });
  }
  return matches.map((entry, index) => ({
    ...entry,
    lines: lines.slice(
      entry.index + 1,
      index + 1 < matches.length ? matches[index + 1].index : lines.length,
    ),
  }));
}

function parseJustification(lines) {
  const start = lines.findIndex((line) =>
    /^##\s+Execution\s+Unit\s+Justification\s*$/i.test(line),
  );
  if (start < 0) return null;
  const end = lines.findIndex(
    (line, index) => index > start && /^##\s+/.test(line),
  );
  const section = lines.slice(start + 1, end < 0 ? lines.length : end);
  const number = scalarAfter(section, /^\s*(?:[-*]\s*)?Number\s+of\s+units\s*:\s*/i);
  const fewer = section
    .map(clean)
    .findIndex((line) => /^Why\s+not\s+fewer\s*:/i.test(line));
  const more = section
    .map(clean)
    .findIndex((line) => /^Why\s+not\s+more\s*:/i.test(line));
  const hasReason = (index) => {
    if (index < 0) return false;
    const nextHeading = section.findIndex(
      (line, candidate) => candidate > index && /^Why\s+not\s+/i.test(clean(line)),
    );
    const body = section
      .slice(index + 1, nextHeading < 0 ? section.length : nextHeading)
      .map(clean)
      .filter((line) => line && !/^[-*]\s*N\/?A\.?$/i.test(line));
    return body.length > 0;
  };
  return {
    number_of_units: parseNumber(number),
    why_not_fewer: hasReason(fewer),
    why_not_more: hasReason(more),
    raw: section,
  };
}

function parseUnit(section, index) {
  const lines = section.lines.map(clean);
  const metadata = {
    id: scalarAfter(lines, /^[-*]\s*id\s*:\s*/i),
    depends_on: splitValues(
      scalarAfter(lines, /^[-*]\s*(?:depends\s+on|depends_on|deps)\s*:\s*/i),
    ),
    effort: scalarAfter(lines, /^[-*]\s*effort\s*:\s*/i),
    confidence: scalarAfter(lines, /^[-*]\s*confidence\s*:\s*/i),
    risk: scalarAfter(lines, /^[-*]\s*risk\s+if\s+wrong\s*:\s*/i),
  };

  const allowedFiles = [];
  let inScope = false;
  let inAcceptance = false;
  let inVerification = false;
  const acceptance = [];
  const verification = [];
  const evidence = [];
  for (const line of lines) {
    if (/^[-*]\s*scope\s*:/i.test(line)) {
      inScope = true;
      inAcceptance = false;
      inVerification = false;
      continue;
    }
    if (/^[-*]\s*acceptance\s+criteria\s*:/i.test(line)) {
      inAcceptance = true;
      inScope = false;
      inVerification = false;
      continue;
    }
    if (/^[-*]\s*verification(?:\s+gates?|\s+steps?)?(?:\s*\([^)]*\))?\s*:/i.test(line)) {
      inVerification = true;
      inAcceptance = false;
      inScope = false;
      continue;
    }
    if (/^[-*]\s*(?:out|related\s+callers?|implementation\s+sketch|stop\s+conditions?)\b/i.test(line)) {
      inAcceptance = false;
      inVerification = false;
      inScope = false;
      continue;
    }
    if (/^[-*]\s*(?:evidence|context)\s*:/i.test(line)) {
      inAcceptance = false;
      inVerification = false;
      inScope = false;
      continue;
    }
    if (/^(?:[-*]\s*)?(?:scope|acceptance|verification|evidence)\b/i.test(line)) {
      // Avoid carrying a section marker across a new metadata field.
      if (!/^[-*]\s{2,}/.test(line)) {
        inAcceptance = false;
        inVerification = false;
      }
    }

    const inMatch = line.match(/^[-*]\s*in\s*:\s*(.+)$/i);
    const filesMatch = line.match(/^[-*]\s*(?:allowed[_ ]files|files)\s*:\s*(.+)$/i);
    if (inMatch) allowedFiles.push(...extractPathTokens(inMatch[1]));
    if (filesMatch) allowedFiles.push(...extractPathTokens(filesMatch[1]));
    if (inScope && !inMatch && !filesMatch) {
      allowedFiles.push(...extractPathTokens(line.replace(/^[-*]\s*/, "")));
    }

    const checkbox = line.match(/^[-*]\s+\[[ xX]\]\s+(.+)$/);
    if (checkbox && inAcceptance) acceptance.push(clean(checkbox[1]));
    if (inVerification) {
      const gate = line.match(/^(?:\d+[.)]|[-*])\s+(.+)$/);
      if (gate && clean(gate[1])) verification.push(clean(gate[1]));
      else if (line) verification.push(line);
    }
    if (/^[-*]\s*evidence\s*:/i.test(line)) evidence.push(line);
  }

  // Some plans use checkbox criteria without a separate marker. Accept those
  // only when they are in the unit section and do not look like a sketch.
  if (acceptance.length === 0) {
    for (const line of lines) {
      const checkbox = line.match(/^[-*]\s+\[[ xX]\]\s+(.+)$/);
      if (checkbox && !/verification|stop condition|rollback/i.test(line)) {
        acceptance.push(clean(checkbox[1]));
      }
    }
  }

  const estimatedLineText = scalarAfter(
    lines,
    /^[-*]\s*(?:estimated\s+)?lines?\s*:\s*/i,
  );
  const title = section.title;
  return {
    id: metadata.id || `unit-${index + 1}`,
    title,
    description: lines
      .filter(
        (line) =>
          line &&
          !/^[-*]\s*(?:id|depends|deps|effort|confidence|risk|scope|acceptance|verification|evidence|allowed|files|estimated\s+lines?|lines?)\b/i.test(line),
      )
      .join(" "),
    depends_on: metadata.depends_on,
    allowed_files: [...new Set(allowedFiles)],
    acceptance_criteria: [...new Set(acceptance)],
    verification_gates: [...new Set(verification)],
    evidence,
    effort: metadata.effort,
    confidence: metadata.confidence,
    risk: metadata.risk,
    estimated_lines: parseNumber(estimatedLineText),
    source_heading: section.title,
  };
}

/** Parse the supported PLAN.md execution-unit formats without executing code. */
export function parsePlanMarkdown(planText) {
  const text = String(planText ?? "");
  const lines = text.replace(/\r/g, "").split("\n");
  const units = headingSections(lines).map(parseUnit);
  const planningMode = scalarAfter(
    lines,
    /^\s*(?:[-*]\s*)?Planning\s+mode\s*:\s*/i,
  );
  return {
    source: "markdown",
    text,
    planning_mode: planningMode ? normalizePlanningMode(planningMode) : null,
    goal: scalarAfter(lines, /^\s*(?:[-*]\s*)?Goal\s*:\s*/i),
    execution_units: units,
    tasks: units,
    justification: parseJustification(lines),
  };
}

function normalizeUnit(raw, index) {
  const unit = raw && typeof raw === "object" ? raw : {};
  const acceptance = unit.acceptance_criteria ?? unit.acceptance ?? unit.criteria;
  const verification = unit.verification_gates ?? unit.verification ?? unit.tests;
  const files = unit.allowed_files ?? unit.files ?? unit.scope?.in;
  return {
    ...unit,
    id: clean(unit.id || unit.unit_id || unit.task_id || `unit-${index + 1}`),
    title: clean(unit.title || unit.name || unit.id || `Execution Unit ${index + 1}`),
    depends_on: splitValues(unit.depends_on ?? unit.deps ?? unit.dependencies),
    allowed_files: Array.isArray(files)
      ? files.map(clean).filter(Boolean)
      : extractPathTokens(files || ""),
    acceptance_criteria: Array.isArray(acceptance)
      ? acceptance.map((item) => clean(typeof item === "object" ? item.criterion || item.text : item)).filter(Boolean)
      : splitValues(acceptance),
    verification_gates: Array.isArray(verification)
      ? verification.map((item) => clean(typeof item === "object" ? item.command || item.cmd || item.text : item)).filter(Boolean)
      : splitValues(verification),
    estimated_lines:
      unit.estimated_lines == null
        ? parseNumber(unit.lines)
        : Number(unit.estimated_lines) || null,
  };
}

export function normalizePlan(plan) {
  if (typeof plan === "string") return parsePlanMarkdown(plan);
  const raw = plan && typeof plan === "object" ? plan : {};
  const candidates = raw.execution_units ?? raw.units ?? raw.tasks;
  const units = Array.isArray(candidates)
    ? candidates.map(normalizeUnit)
    : [];
  return {
    ...raw,
    source: raw.source || "json",
    planning_mode: raw.planning_mode || raw.planningMode || null,
    execution_units: units,
    tasks: units,
    justification: raw.justification || raw.execution_unit_justification || null,
  };
}

function titleTokens(unit) {
  return new Set(
    `${unit.title || ""}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !GENERIC_TITLE_WORDS.has(token)),
  );
}

function sameFeatureOutcome(a, b) {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (left.size === 0 || right.size === 0) return false;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection >= 2 && intersection / Math.min(left.size, right.size) >= 0.5;
}

function isTestOnly(unit) {
  const files = unit.allowed_files || [];
  if (files.length === 0) return /\btests?\b/i.test(unit.title || "") && !/\b(?:api|service|model|endpoint|source)\b/i.test(unit.title || "");
  return files.every((file) => /(^|\/)(?:test|tests|spec|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$/i.test(file));
}

function isSetupOnly(unit) {
  const text = `${unit.title || ""} ${unit.description || ""}`;
  const files = unit.allowed_files || [];
  return (
    /\b(?:setup|scaffold|bootstrap|wiring|plumbing|configuration|config)\b/i.test(text) &&
    (files.length === 0 || files.every((file) => /(?:config|setup|fixture|scaffold|bootstrap|\.env)/i.test(file)))
  );
}

function unitOverlap(a, b) {
  const left = a.allowed_files || [];
  const right = b.allowed_files || [];
  const pairs = [];
  for (const one of left) {
    for (const two of right) {
      if (globsOverlap(one, two)) pairs.push([one, two]);
    }
  }
  const union = new Set([...left, ...right]).size;
  return { pairs, ratio: union ? pairs.length / union : 0 };
}

function describeCandidate(a, b, overlap) {
  const reasons = [];
  if (overlap.pairs.length > 0) reasons.push("overlapping allowed_files");
  if (sameFeatureOutcome(a, b)) reasons.push("same feature outcome language");
  if (isTestOnly(a) && b.depends_on?.includes(a.id)) reasons.push("tests are only for the dependent unit");
  if (isTestOnly(b) && a.depends_on?.includes(b.id)) reasons.push("tests are only for the dependent unit");
  return reasons;
}

/**
 * Run the deterministic pre-finalization linter. Warnings are actionable but
 * do not fail normal mode; --strict can turn them into a hard planning gate.
 */
export function checkPlan(plan, options = {}) {
  const normalized = normalizePlan(plan);
  const units = normalized.execution_units;
  const errors = [];
  const warnings = [];
  const mergeCandidates = [];
  const duplicateFiles = new Map();
  const maxFiles = Number(options.maxFiles) > 0 ? Number(options.maxFiles) : 12;
  const maxLines = Number(options.maxLines) > 0 ? Number(options.maxLines) : 400;

  if (units.length === 0) {
    errors.push({ code: "NO_EXECUTION_UNITS", message: "plan must define at least one Execution Unit" });
  }

  const ids = new Map();
  for (const unit of units) {
    if (ids.has(unit.id)) {
      errors.push({ code: "DUPLICATE_UNIT_ID", unit: unit.id, message: `duplicate execution unit id ${unit.id}` });
    }
    ids.set(unit.id, unit);
    for (const file of unit.allowed_files || []) {
      if (!duplicateFiles.has(file)) duplicateFiles.set(file, []);
      duplicateFiles.get(file).push(unit.id);
    }
    if ((unit.acceptance_criteria || []).length === 0) {
      errors.push({ code: "MISSING_ACCEPTANCE", unit: unit.id, message: `${unit.id} has no acceptance criteria` });
    }
    if ((unit.verification_gates || []).length === 0) {
      errors.push({ code: "MISSING_VERIFICATION", unit: unit.id, message: `${unit.id} has no verification gate` });
    }
    if ((unit.allowed_files || []).length > maxFiles) {
      warnings.push({ code: "OVERSIZED_UNIT", unit: unit.id, message: `${unit.id} names ${unit.allowed_files.length} allowed files; reviewer auditability is at risk` });
    }
    if (Number(unit.estimated_lines) > maxLines || /^XL\b/i.test(unit.effort || "")) {
      warnings.push({ code: "OVERSIZED_UNIT", unit: unit.id, message: `${unit.id} is larger than the default reviewer-audit threshold` });
    }
    if (isTestOnly(unit)) {
      warnings.push({ code: "TEST_ONLY_UNIT", unit: unit.id, message: `${unit.id} appears to add tests without production behavior; merge it with the behavior it verifies` });
    }
    if (isSetupOnly(unit)) {
      warnings.push({ code: "SETUP_ONLY_UNIT", unit: unit.id, message: `${unit.id} appears to be setup-only; merge it unless the boundary is independently shippable` });
    }
    for (const dep of unit.depends_on || []) {
      if (!ids.has(dep) && !units.some((candidate) => candidate.id === dep)) {
        errors.push({ code: "UNKNOWN_DEPENDENCY", unit: unit.id, dependency: dep, message: `${unit.id} depends on unknown execution unit ${dep}` });
      }
    }
  }

  for (const [file, owners] of duplicateFiles) {
    if (owners.length > 1) {
      warnings.push({ code: "DUPLICATE_ALLOWED_FILE", file, units: owners, message: `${file} is allowed in multiple units: ${owners.join(", ")}` });
    }
  }

  let dag = null;
  if (units.length > 0 && errors.every((error) => error.code !== "DUPLICATE_UNIT_ID" && error.code !== "UNKNOWN_DEPENDENCY")) {
    try {
      dag = buildTaskDag(units);
      const cycle = detectCycle(dag);
      if (cycle) errors.push({ code: "DEPENDENCY_CYCLE", message: `dependency cycle: ${cycle.join(" → ")}`, cycle });
    } catch (error) {
      errors.push({ code: "INVALID_DAG", message: error.message });
    }
  }

  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const overlap = unitOverlap(units[i], units[j]);
      const reasons = describeCandidate(units[i], units[j], overlap);
      if (reasons.length > 0) {
        const candidate = {
          units: [units[i].id, units[j].id],
          overlap_ratio: Number(overlap.ratio.toFixed(3)),
          reasons,
          message: `${units[i].id} and ${units[j].id} are merge candidates: ${reasons.join(", ")}`,
        };
        mergeCandidates.push(candidate);
        warnings.push({ code: "MERGE_CANDIDATE", ...candidate });
      }
    }
  }

  const justification = normalized.justification;
  if (!justification) {
    errors.push({ code: "MISSING_UNIT_JUSTIFICATION", message: "plan must include ## Execution Unit Justification" });
  } else {
    if (justification.number_of_units != null && justification.number_of_units !== units.length) {
      errors.push({ code: "UNIT_COUNT_MISMATCH", message: `justification says ${justification.number_of_units} units but plan defines ${units.length}` });
    }
    if (!justification.why_not_fewer) {
      errors.push({ code: "MISSING_FEWER_JUSTIFICATION", message: "Execution Unit Justification needs a Why not fewer rationale" });
    }
    if (!justification.why_not_more) {
      errors.push({ code: "MISSING_MORE_JUSTIFICATION", message: "Execution Unit Justification needs a Why not more rationale" });
    }
  }

  const planningMode = normalizePlanningMode(
    normalized.planning_mode || options.planningMode || inferPlanningMode({ unit_count: units.length }),
    "standard",
  );
  const estimate = estimateAgentCalls({
    units: units.length || 1,
    planningMode,
    fixLoops: options.fixLoops,
    singleUnitFinalReviewReuse: options.singleUnitFinalReviewReuse,
  });
  const schedule = dag
    ? scheduleParallel(dag, {
        maxConcurrency: Math.max(1, Number(options.maxConcurrency) || 1),
      })
    : { ok: false };
  const suggestedUnitCount = Math.max(
    1,
    Math.min(
      units.length || 1,
      units.length - mergeCandidates.length,
    ),
  );
  const strictFailure = options.strict === true && warnings.length > 0;
  return {
    ok: errors.length === 0 && !strictFailure,
    plan_check: errors.length === 0 ? (warnings.length > 0 ? "WARN" : "PASS") : "FAIL",
    source: normalized.source,
    unit_count: units.length,
    execution_units: units,
    tasks: units,
    planning_mode: planningMode,
    errors,
    warnings,
    merge_candidates: mergeCandidates,
    suggested_unit_count: suggestedUnitCount,
    estimate,
    dag: schedule,
  };
}

export function checkPlanFile(planPath, options = {}) {
  const absolute = path.resolve(planPath);
  if (!fs.existsSync(absolute)) {
    return {
      ok: false,
      plan_check: "FAIL",
      plan_path: planPath,
      source: "missing",
      unit_count: 0,
      execution_units: [],
      tasks: [],
      planning_mode: null,
      errors: [{ code: "PLAN_NOT_FOUND", message: `plan file not found: ${planPath}` }],
      warnings: [],
      merge_candidates: [],
      suggested_unit_count: 0,
      estimate: estimateAgentCalls({ units: 1 }),
    };
  }
  const result = checkPlan(fs.readFileSync(absolute, "utf8"), options);
  return { ...result, plan_path: planPath };
}
