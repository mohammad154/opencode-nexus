/**
 * PR8: SPEC identity, traceability, and convergence.
 *
 * Intent is named once and then traced, instead of being re-derived from prose
 * by every agent:
 *
 *   requirement (plan `## Requirements`, optional)
 *     -> execution unit (`covers:`)
 *       -> acceptance criterion (stable id + content digest)
 *         -> approved task review that reported PASS for it
 *
 * Two properties make this a gate rather than a report:
 *
 * 1. Identity is deterministic. A criterion id is its unit id plus its 1-based
 *    position, and its digest is taken from the normalized criterion text, so
 *    the same plan always yields the same ledger and an edit after review is
 *    detectable.
 * 2. Convergence is computed only from durable evidence the existing gates
 *    already persisted (`state.execution_units` from the PLANNED gate,
 *    `state.task_history` from admissible approvals). This module measures; it
 *    never accepts a caller's claim that something was covered.
 *
 * Every function here is pure. No filesystem, no git, no spawning.
 */
import crypto from "node:crypto";

export const TRACE_VERSION = "nexus-trace/1";

/**
 * Criterion coverage outcomes, worst first.
 *
 * `COVERED` may carry `positional_match: true`, meaning the review's evidence
 * was matched by its legacy `AC-n` position rather than by the criterion's own
 * identity. That is reported and counted, never rejected: paraphrasing a
 * criterion when authorizing a unit is a weaker signal than an abandoned unit,
 * and a run must not fail at COMPLETED for wording.
 */
export const COVERAGE_STATUS = {
  NO_CRITERIA: "NO_CRITERIA",
  NOT_REVIEWED: "NOT_REVIEWED",
  NOT_APPROVED: "NOT_APPROVED",
  COVERED: "COVERED",
};

/** Normalize criterion text so cosmetic edits do not look like intent changes. */
export function normalizeCriterionText(value) {
  return String(value ?? "")
    .replace(/^[-*]\s*/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Content identity of one criterion: 12 hex chars of its normalized text. */
export function criterionDigest(value) {
  const normalized = normalizeCriterionText(value);
  if (!normalized) return null;
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/** Stable criterion id: unit id plus 1-based position within that unit. */
export function criterionId(unitId, index) {
  return `${String(unitId || "unit")}/AC${Number(index) + 1}`;
}

/** The legacy per-unit id a reviewer may still use (`AC-1`, `AC-2`, ...). */
export function legacyCriterionId(index) {
  return `AC-${Number(index) + 1}`;
}

function unitsOf(state = {}) {
  const units = state.execution_units || state.units || state.tasks;
  return Array.isArray(units) ? units.filter((u) => u && typeof u === "object") : [];
}

function criteriaOf(unit = {}) {
  const raw =
    unit.acceptance_criteria ?? unit.acceptance ?? unit.criteria ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((item) =>
      typeof item === "object" && item
        ? String(item.criterion || item.text || item.id || "")
        : String(item ?? ""),
    )
    .map((text) => text.trim())
    .filter(Boolean);
}

/**
 * The plan's criterion ledger: one row per acceptance criterion of every
 * planned execution unit, in plan order.
 * @returns {Array<{id: string, unit: string, index: number, text: string, digest: string|null, legacy_id: string}>}
 */
export function planCriteria(state = {}) {
  const rows = [];
  for (const unit of unitsOf(state)) {
    const unitId = String(unit.id || `unit-${rows.length + 1}`);
    const criteria = criteriaOf(unit);
    criteria.forEach((text, index) => {
      rows.push({
        id: criterionId(unitId, index),
        unit: unitId,
        index,
        text,
        digest: criterionDigest(text),
        legacy_id: legacyCriterionId(index),
      });
    });
  }
  return rows;
}

/** Planned unit ids, in plan order. */
export function plannedUnitIds(state = {}) {
  return unitsOf(state).map((unit, index) => String(unit.id || `unit-${index + 1}`));
}

function historyEntries(state = {}) {
  const history = Array.isArray(state.task_history) ? state.task_history : [];
  return history.filter((entry) => entry && typeof entry === "object");
}

/**
 * Approved task reviews, newest last, keyed by unit. Only `APPROVED` entries
 * count: a `REQUEST_CHANGES` record is history, not coverage.
 */
export function approvedReviews(state = {}) {
  const byUnit = new Map();
  for (const entry of historyEntries(state)) {
    const unit = String(entry.id || entry.unit_or_task || entry.unit || "");
    if (!unit) continue;
    const verdict = String(entry.verdict || entry.review_handoff?.verdict || "");
    if (verdict !== "APPROVED") continue;
    byUnit.set(unit, entry);
  }
  return byUnit;
}

/**
 * Acceptance entries a review reported, indexed for matching by stable id,
 * legacy id, digest, or normalized text.
 */
function acceptanceIndex(entry) {
  const handoff = entry?.review_handoff || {};
  const acceptance = Array.isArray(handoff.acceptance) ? handoff.acceptance : [];
  const index = new Map();
  for (const item of acceptance) {
    if (!item || typeof item !== "object") continue;
    const keys = [
      String(item.id || ""),
      String(item.criterion_id || ""),
      normalizeCriterionText(item.id),
      normalizeCriterionText(item.criterion || item.text),
    ].filter(Boolean);
    const digest = criterionDigest(item.criterion || item.text || "");
    if (digest) keys.push(digest);
    for (const key of keys) if (!index.has(key)) index.set(key, item);
  }
  return index;
}

/**
 * Match a plan criterion to a reported acceptance entry. Identity first
 * (stable id, digest, exact text); the legacy positional `AC-n` id is the last
 * resort and is flagged, because position alone does not prove the reviewer
 * examined this criterion.
 */
function matchAcceptance(index, row) {
  const byIdentity =
    index.get(row.id) ||
    index.get(normalizeCriterionText(row.text)) ||
    (row.digest ? index.get(row.digest) : null);
  if (byIdentity) return { match: byIdentity, positional: false };
  const byPosition = index.get(row.legacy_id);
  if (byPosition) return { match: byPosition, positional: true };
  return { match: null, positional: false };
}

/**
 * Trace every planned criterion to the review evidence that demonstrated it.
 *
 * `NOT_REVIEWED` means the owning unit has no approved review at all — the case
 * where a planned unit is silently abandoned. `NOT_APPROVED` means the unit was
 * approved but this criterion carries no passing result. `TEXT_CHANGED` means
 * the plan's criterion text no longer matches what the review examined.
 *
 * @returns {{version: string, rows: Array<object>, units: Array<object>, requirements: Array<object>, summary: object}}
 */
export function traceMatrix(state = {}) {
  const rows = planCriteria(state);
  const approved = approvedReviews(state);
  const indexes = new Map();
  for (const [unit, entry] of approved) indexes.set(unit, acceptanceIndex(entry));

  const traced = rows.map((row) => {
    const entry = approved.get(row.unit);
    if (!entry) {
      return { ...row, status: COVERAGE_STATUS.NOT_REVIEWED, reviewed_commit: null, evidence: [] };
    }
    const { match, positional } = matchAcceptance(indexes.get(row.unit), row);
    if (!match || match.status !== "PASS") {
      return {
        ...row,
        status: COVERAGE_STATUS.NOT_APPROVED,
        reviewed_commit: entry.reviewed_commit || null,
        reported_status: match ? String(match.status) : null,
        evidence: [],
      };
    }
    // Did the criteria authorized for this unit actually contain this text? A
    // mismatch is recorded for visibility; it does not withhold coverage.
    const reviewedTexts = Array.isArray(entry.acceptance_criteria)
      ? entry.acceptance_criteria.map(normalizeCriterionText)
      : [];
    const textMatched =
      reviewedTexts.length === 0 ||
      reviewedTexts.includes(normalizeCriterionText(row.text));
    return {
      ...row,
      status: COVERAGE_STATUS.COVERED,
      positional_match: positional,
      authorized_text_match: textMatched,
      reviewed_commit: entry.reviewed_commit || null,
      reported_status: "PASS",
      evidence: Array.isArray(match.evidence) ? match.evidence : [],
    };
  });

  const units = plannedUnitIds(state).map((unit) => {
    const unitRows = traced.filter((row) => row.unit === unit);
    const entry = approved.get(unit);
    return {
      unit,
      reviewed: Boolean(entry),
      reviewed_commit: entry?.reviewed_commit || null,
      criteria: unitRows.length,
      covered: unitRows.filter((row) => row.status === COVERAGE_STATUS.COVERED).length,
      status: !entry
        ? COVERAGE_STATUS.NOT_REVIEWED
        : unitRows.length === 0
          ? COVERAGE_STATUS.NO_CRITERIA
          : unitRows.every((row) => row.status === COVERAGE_STATUS.COVERED)
            ? COVERAGE_STATUS.COVERED
            : COVERAGE_STATUS.NOT_APPROVED,
    };
  });

  const requirements = requirementCoverage(state, traced);
  const covered = traced.filter((row) => row.status === COVERAGE_STATUS.COVERED).length;
  return {
    version: TRACE_VERSION,
    rows: traced,
    units,
    requirements,
    summary: {
      units_planned: units.length,
      units_reviewed: units.filter((unit) => unit.reviewed).length,
      criteria_planned: traced.length,
      criteria_covered: covered,
      criteria_uncovered: traced.length - covered,
      requirements_declared: requirements.length,
      requirements_covered: requirements.filter((r) => r.status === COVERAGE_STATUS.COVERED).length,
      criteria_positional_match: traced.filter((row) => row.positional_match).length,
      criteria_text_drift: traced.filter(
        (row) => row.status === COVERAGE_STATUS.COVERED && row.authorized_text_match === false,
      ).length,
      converged: traced.length > 0 && covered === traced.length &&
        units.every((unit) => unit.reviewed) &&
        requirements.every((r) => r.status === COVERAGE_STATUS.COVERED),
    },
  };
}

/**
 * Declared requirements come from the plan's optional `## Requirements`
 * section, which plan-check parses. A requirement is covered when at least one
 * unit that declares `covers: <id>` is itself fully covered.
 */
export function planRequirements(state = {}) {
  const raw = Array.isArray(state.requirements)
    ? state.requirements
    : Array.isArray(state.plan_check?.requirements)
      ? state.plan_check.requirements
      : [];
  return raw
    .filter((item) => item && typeof item === "object" && item.id)
    .map((item) => ({
      id: String(item.id),
      text: String(item.text || ""),
      digest: criterionDigest(item.text || item.id),
    }));
}

/** Unit ids that declare they cover a requirement id. */
export function unitsCovering(state = {}, requirementId) {
  const want = String(requirementId).toLowerCase();
  return unitsOf(state)
    .filter((unit) => {
      const covers = unit.covers ?? unit.requirements ?? [];
      const list = Array.isArray(covers) ? covers : String(covers).split(/[,\s]+/);
      return list.map((v) => String(v).trim().toLowerCase()).includes(want);
    })
    .map((unit, index) => String(unit.id || `unit-${index + 1}`));
}

function requirementCoverage(state = {}, tracedRows = []) {
  return planRequirements(state).map((requirement) => {
    const units = unitsCovering(state, requirement.id);
    if (units.length === 0) {
      return { ...requirement, units: [], status: COVERAGE_STATUS.NOT_REVIEWED };
    }
    const rows = tracedRows.filter((row) => units.includes(row.unit));
    const covered =
      rows.length > 0 && rows.every((row) => row.status === COVERAGE_STATUS.COVERED);
    return {
      ...requirement,
      units,
      status: covered ? COVERAGE_STATUS.COVERED : COVERAGE_STATUS.NOT_APPROVED,
    };
  });
}

/**
 * The PLANNED-gate check: a plan that declares requirements must map every one
 * of them to at least one execution unit. Plans without a `## Requirements`
 * section are unaffected.
 * @returns {string[]}
 */
export function requirementMappingErrors(planCheckOrState = {}) {
  const errors = [];
  const requirements = planRequirements(planCheckOrState);
  if (requirements.length === 0) return errors;
  const known = new Set(plannedUnitIds(planCheckOrState));
  for (const requirement of requirements) {
    const units = unitsCovering(planCheckOrState, requirement.id);
    if (units.length === 0) {
      errors.push(
        `requirement ${requirement.id} is declared but no execution unit declares "covers: ${requirement.id}"`,
      );
      continue;
    }
    for (const unit of units) {
      if (!known.has(unit)) {
        errors.push(`requirement ${requirement.id} maps to unknown unit ${unit}`);
      }
    }
  }
  return errors;
}

/**
 * The convergence gate. Every planned execution unit must have an approved
 * review, and every planned acceptance criterion must carry a PASS from it.
 *
 * Vacuous by construction when the run has no persisted plan units: this gate
 * adds a requirement, it does not invent a plan that was never persisted.
 *
 * @param {object} state durable run state
 * @param {{label?: string}} [opts]
 * @returns {string[]} verbatim gate errors
 */
export function convergenceErrors(state = {}, opts = {}) {
  const label = opts.label || "COMPLETED";
  const units = plannedUnitIds(state);
  if (units.length === 0) return [];

  const matrix = traceMatrix(state);
  const errors = [];

  const unreviewed = matrix.units.filter((unit) => !unit.reviewed).map((unit) => unit.unit);
  if (unreviewed.length > 0) {
    errors.push(
      `${label} requires an approved task review for every planned execution unit; missing: ${unreviewed.join(", ")}`,
    );
  }

  // Units with no review are already reported above; do not repeat every one of
  // their criteria.
  const notApproved = matrix.rows
    .filter(
      (row) =>
        row.status === COVERAGE_STATUS.NOT_APPROVED && !unreviewed.includes(row.unit),
    )
    .map((row) => `${row.id} (${row.text})`);
  if (notApproved.length > 0) {
    errors.push(
      `${label} requires a passing acceptance result for every planned criterion; missing: ${notApproved.join("; ")}`,
    );
  }

  const uncoveredRequirements = matrix.requirements
    .filter((requirement) => requirement.status !== COVERAGE_STATUS.COVERED)
    .map((requirement) => requirement.id);
  if (uncoveredRequirements.length > 0) {
    errors.push(
      `${label} requires demonstrated coverage for every declared requirement; missing: ${uncoveredRequirements.join(", ")}`,
    );
  }

  return errors;
}

/** Human-readable trace report. */
export function formatTrace(matrix) {
  const lines = ["## Nexus Trace"];
  const s = matrix.summary;
  lines.push(
    `- units: ${s.units_reviewed}/${s.units_planned} reviewed`,
    `- criteria: ${s.criteria_covered}/${s.criteria_planned} covered`,
  );
  if (s.requirements_declared > 0) {
    lines.push(
      `- requirements: ${s.requirements_covered}/${s.requirements_declared} covered`,
    );
  }
  lines.push(`- converged: ${s.converged ? "yes" : "no"}`);
  for (const unit of matrix.units) {
    lines.push(`\n### ${unit.unit} — ${unit.status}`);
    if (unit.reviewed_commit) lines.push(`- reviewed_commit: ${unit.reviewed_commit}`);
    for (const row of matrix.rows.filter((r) => r.unit === unit.unit)) {
      const mark = row.status === COVERAGE_STATUS.COVERED ? "x" : " ";
      lines.push(`- [${mark}] ${row.id} ${row.status}: ${row.text}`);
    }
  }
  for (const requirement of matrix.requirements) {
    lines.push(
      `\n### ${requirement.id} — ${requirement.status} (units: ${requirement.units.join(", ") || "none"})`,
    );
    if (requirement.text) lines.push(`- ${requirement.text}`);
  }
  return lines.join("\n");
}
