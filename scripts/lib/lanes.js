/**
 * Guarded parallel execution: deterministic lane eligibility and join guards
 * (PR9).
 *
 * The plan has always carried a parallel schedule (`scripts/lib/task-dag.js`
 * computes dependency waves and refuses to co-schedule units that could touch
 * the same files), but nothing executed it: the runtime implements one unit at a
 * time, so N independent units cost N serial implementer dispatches of
 * wall-clock time.
 *
 * A *lane* makes one wave executable. A lane is deliberately small: an isolated
 * worktree and branch in which one execution unit's implementer runs. A lane has
 * no state machine, authorizes nothing, and cannot complete anything. The parent
 * run remains the only authority.
 *
 * The join is what keeps every existing gate intact. Lane work is rebased onto
 * the parent tip before the parent consumes it, so the handoff the parent sees
 * is an ordinary implementer handoff whose `base_commit` is the parent's
 * authorization base and whose `commit` is the parent's worktree HEAD. Nothing
 * about scope lock, deterministic verification, task-review binding, or PR8
 * convergence is relaxed or special-cased: the parent runs its normal chain over
 * work that merely happened to be produced earlier and elsewhere.
 *
 * This module is pure. Every fact it judges (a rebase conflicted, the rebased
 * diff touched these files, this commit is an ancestor of that one) is measured
 * from git by the caller and passed in, so the guards can be tested without a
 * repository and cannot be satisfied by an agent's claim.
 */

import { buildExecutionUnitDag, detectCycle, unitsShareFiles } from "./task-dag.js";
import { approvedReviews, plannedUnitIds } from "./traceability.js";
import { canonicalTaskId } from "./worktree.js";

export const LANE_VERSION = "nexus-lane/1";

/**
 * Concurrency ceiling. Lanes spend no extra agent calls (the same N implementer
 * dispatches happen either way), but each one is a worktree, a branch, and a
 * dispatch a human may have to reason about, so the width stays small enough to
 * stay reviewable.
 */
export const MAX_LANE_CONCURRENCY = 4;
export const DEFAULT_LANE_CONCURRENCY = 2;

/** Why a planned unit is not in this wave. Every exclusion is explicit. */
export const LANE_EXCLUSION = Object.freeze({
  ALREADY_COVERED: "ALREADY_COVERED",
  IN_FLIGHT: "IN_FLIGHT",
  DEPENDENCY_PENDING: "DEPENDENCY_PENDING",
  UNKNOWN_SCOPE: "UNKNOWN_SCOPE",
  FILE_CONFLICT: "FILE_CONFLICT",
  CONCURRENCY_LIMIT: "CONCURRENCY_LIMIT",
});

export const LANE_STATUS = Object.freeze({
  RUNNING: "RUNNING",
  IMPLEMENTED: "IMPLEMENTED",
  JOINED: "JOINED",
  ABANDONED: "ABANDONED",
});

function unitList(state) {
  return Array.isArray(state?.execution_units) ? state.execution_units : [];
}

function allowedFilesOf(unit) {
  const files = unit?.allowed_files || unit?.files;
  return Array.isArray(files) ? files.filter((file) => typeof file === "string" && file.trim()) : [];
}

function dependenciesOf(unit) {
  const deps = unit?.depends_on || unit?.deps;
  return Array.isArray(deps) ? deps.map(String) : [];
}

/**
 * Units the parent has fully processed: an approved task review is in the PR8
 * ledger.
 *
 * A merely merged unit is deliberately not "done" here. A dependent unit's lane
 * must start from a tip that already contains what it depends on, and waiting
 * for the review as well costs nothing in the case lanes exist for (independent
 * units) while keeping the rule easy to state and impossible to get subtly
 * wrong.
 */
export function completedUnits(state) {
  return new Set(approvedReviews(state).keys());
}

/**
 * Lane identity, safe for a filesystem path and a git ref.
 *
 * Only ids that are *already* safe are accepted. `canonicalTaskId` can encode a
 * hostile id into a safe single path segment, but a lane id also becomes a git
 * ref and appears in operator-facing output, so an id that needs encoding is
 * rejected instead: plan unit ids are simple by construction, and PR7 showed
 * what an unsanitized unit id can reach.
 */
function safeId(value) {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return null;
  return canonicalTaskId(raw) === raw ? raw : null;
}

export function laneId(unitId) {
  const safe = safeId(unitId);
  return safe ? `lane-${safe}` : null;
}

/** Lane branch name; `runId` keeps concurrent runs from colliding. */
export function laneBranch(runId, unitId) {
  const lane = laneId(unitId);
  const run = safeId(String(runId || ""));
  if (!lane || !run) return null;
  return `nexus/${run}/${lane}`;
}

/**
 * Deterministically select the next wave of units whose implementers may run
 * concurrently.
 *
 * Conservative by construction: a unit joins the wave only when its identity,
 * dependencies, and file scope are all known and provably independent of every
 * other lane and of whatever the parent already has in flight. Anything else is
 * excluded with a reason rather than risked.
 */
export function laneEligibility(state, options = {}) {
  const requested = Number(options.maxConcurrency ?? DEFAULT_LANE_CONCURRENCY);
  const errors = [];
  if (!Number.isInteger(requested) || requested < 1) {
    errors.push("max concurrency must be a positive integer");
  } else if (requested > MAX_LANE_CONCURRENCY) {
    errors.push(`max concurrency ${requested} exceeds the ceiling of ${MAX_LANE_CONCURRENCY}`);
  }
  const maxConcurrency = errors.length === 0 ? requested : DEFAULT_LANE_CONCURRENCY;

  const units = unitList(state);
  const planned = plannedUnitIds(state);
  if (planned.length === 0) {
    // No persisted plan units: there is nothing to parallelize and nothing to
    // guard. Lanes add a capability, they never invent a plan.
    return {
      ok: false,
      version: LANE_VERSION,
      max_concurrency: maxConcurrency,
      wave: [],
      excluded: [],
      errors: errors.length > 0 ? errors : ["no planned execution units to schedule"],
    };
  }

  let dag;
  try {
    dag = buildExecutionUnitDag(units);
  } catch (error) {
    return {
      ok: false,
      version: LANE_VERSION,
      max_concurrency: maxConcurrency,
      wave: [],
      excluded: [],
      errors: [...errors, `execution-unit DAG is unusable: ${String(error.message || error)}`],
    };
  }
  const cycle = detectCycle(dag);
  if (cycle) {
    return {
      ok: false,
      version: LANE_VERSION,
      max_concurrency: maxConcurrency,
      wave: [],
      excluded: [],
      errors: [...errors, `dependency cycle: ${cycle.join(" → ")}`],
    };
  }

  const completed = completedUnits(state);
  // Lanes are recorded outside the run state (see lane-runtime.js), so the
  // caller supplies them; nothing is assumed about unreported lanes.
  const activeLanes = Array.isArray(options.activeLanes) ? options.activeLanes : [];
  const inFlight = new Set(activeLanes.map((lane) => String(lane?.unit || "")).filter(Boolean));
  // The unit the parent itself is working on occupies scope exactly like a lane.
  const parentUnit =
    typeof state?.current_unit === "string" && !completed.has(state.current_unit)
      ? state.current_unit
      : null;
  if (parentUnit) inFlight.add(parentUnit);

  const excluded = [];
  const wave = [];
  const claimed = [];
  for (const id of inFlight) {
    const unit = units.find((candidate) => candidate?.id === id);
    if (unit) claimed.push({ id, files: allowedFilesOf(unit) });
  }

  for (const unit of units) {
    const id = String(unit?.id || "");
    if (!id) continue;
    const note = (reason, detail) => excluded.push({ id, reason, ...(detail ? { detail } : {}) });
    if (completed.has(id)) {
      note(LANE_EXCLUSION.ALREADY_COVERED);
      continue;
    }
    if (inFlight.has(id)) {
      note(LANE_EXCLUSION.IN_FLIGHT);
      continue;
    }
    const pending = dependenciesOf(unit).filter((dep) => !completed.has(dep));
    if (pending.length > 0) {
      note(LANE_EXCLUSION.DEPENDENCY_PENDING, pending.join(", "));
      continue;
    }
    const files = allowedFilesOf(unit);
    if (files.length === 0) {
      // An unbounded or unknown allowlist can never be proven disjoint, and
      // scope lock already fails closed on it. Never parallelize it.
      note(LANE_EXCLUSION.UNKNOWN_SCOPE);
      continue;
    }
    const candidate = { id, files };
    const conflict = claimed.find((other) => unitsShareFiles(candidate, other));
    if (conflict) {
      note(LANE_EXCLUSION.FILE_CONFLICT, conflict.id);
      continue;
    }
    if (wave.length >= maxConcurrency) {
      note(LANE_EXCLUSION.CONCURRENCY_LIMIT);
      continue;
    }
    wave.push({
      id,
      allowed_files: files,
      depends_on: dependenciesOf(unit),
      acceptance_criteria: Array.isArray(unit?.acceptance_criteria)
        ? unit.acceptance_criteria.map(String)
        : [],
      user_outcome: unit?.user_outcome || null,
      lane: laneId(id),
      branch: laneBranch(state?.run_id, id),
    });
    claimed.push(candidate);
  }

  return {
    ok: errors.length === 0 && wave.length > 0,
    version: LANE_VERSION,
    max_concurrency: maxConcurrency,
    wave,
    excluded,
    errors,
    // One unit alone is the ordinary sequential path; parallelism starts at two.
    parallel: wave.length > 1,
  };
}

/** Lane records persisted for a run, newest state per unit. */
export function laneRecords(laneFile) {
  const lanes = Array.isArray(laneFile?.lanes) ? laneFile.lanes : [];
  return lanes.filter((lane) => lane && typeof lane.unit === "string");
}

/** Lanes that still hold scope: started or implemented but not yet joined. */
export function openLanes(laneFile) {
  return laneRecords(laneFile).filter(
    (lane) => lane.status === LANE_STATUS.RUNNING || lane.status === LANE_STATUS.IMPLEMENTED,
  );
}

/** The lane record for a unit, or null. */
export function findLane(laneFile, unitId) {
  return laneRecords(laneFile).find((lane) => lane.unit === unitId) || null;
}

/**
 * May this lane's work be joined into the parent?
 *
 * Every argument is a fact the caller measured from git after performing the
 * rebase. The lane's own claims are never inputs to this decision.
 *
 * @param {object} facts
 * @param {string} facts.unit unit the lane implemented
 * @param {string[]} facts.allowedFiles the unit's persisted scope
 * @param {string[]} facts.diffFiles files the rebased work actually changes
 * @param {boolean} facts.conflicted whether the rebase hit a conflict
 * @param {string|null} facts.parentBase parent tip the work was rebased onto
 * @param {string|null} facts.joinedCommit resulting commit
 * @param {boolean|null} facts.ancestor whether parentBase is an ancestor of joinedCommit
 * @param {object|null} facts.laneHandoff the lane implementer's handoff
 */
export function laneJoinErrors(facts = {}) {
  const errors = [];
  const unit = String(facts.unit || "");
  if (!unit) errors.push("lane join requires the unit it implemented");

  if (facts.conflicted === true) {
    // Units in a wave are file-disjoint by construction, so a conflict is proof
    // that the guard was wrong about this pair. Never auto-resolve: a resolution
    // is an unreviewed code change.
    errors.push(
      `lane ${unit} conflicts with the parent branch — the wave's file-disjointness guard did not hold; abort the lane and implement it sequentially`,
    );
  }

  const handoff = facts.laneHandoff;
  if (!handoff || typeof handoff !== "object") {
    errors.push(`lane ${unit} has no implementer handoff to join`);
  } else {
    if (!String(handoff.status || "").toUpperCase().startsWith("DONE")) {
      errors.push(`lane ${unit} implementer status must be DONE*, got ${handoff.status || "none"}`);
    }
    const handoffUnit = handoff.unit_or_task || handoff.task_id;
    if (handoffUnit && handoffUnit !== unit) {
      errors.push(`lane ${unit} handoff reports a different unit (${handoffUnit})`);
    }
    if (handoff.agent && handoff.agent !== "implementer") {
      errors.push(`lane ${unit} handoff agent must be implementer, got ${handoff.agent}`);
    }
  }

  if (!facts.joinedCommit) {
    errors.push(`lane ${unit} produced no commit to join`);
  }
  if (facts.parentBase && facts.joinedCommit && facts.ancestor === false) {
    errors.push(
      `lane ${unit} joined commit ${facts.joinedCommit} is not a descendant of the parent tip ${facts.parentBase}`,
    );
  }

  // Scope is re-measured on the rebased work. The parent's own scope lock will
  // check this again from git at VERIFYING; catching it here means a violation
  // is reported before the parent branch is advanced.
  const allowed = Array.isArray(facts.allowedFiles) ? facts.allowedFiles : [];
  const diff = Array.isArray(facts.diffFiles) ? facts.diffFiles : [];
  if (allowed.length === 0) {
    errors.push(`lane ${unit} has no persisted allowed_files — scope cannot be proven`);
  } else if (diff.length === 0 && facts.conflicted !== true) {
    errors.push(`lane ${unit} changes nothing — there is no implementation to join`);
  } else {
    const outside = diff.filter((file) => !matchesAllowed(file, allowed));
    if (outside.length > 0) {
      errors.push(
        `lane ${unit} changed files outside its scope: ${outside.slice(0, 10).join(", ")}`,
      );
    }
  }
  return errors;
}

/** Minimal allowlist match: exact path, directory prefix, or glob. */
function matchesAllowed(file, allowed) {
  const target = String(file || "").replace(/\\/g, "/");
  return allowed.some((pattern) => {
    const raw = String(pattern || "").replace(/\\/g, "/");
    if (!raw) return false;
    if (raw === "*" || raw === "**") return true;
    if (raw === target) return true;
    if (raw.endsWith("/")) return target.startsWith(raw);
    if (!raw.includes("*") && !raw.includes("?")) {
      return target === raw || target.startsWith(`${raw}/`);
    }
    return globToRegExp(raw).test(target);
  });
}

function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * Re-bind a lane's implementer handoff to the commits the join just created.
 *
 * The join rewrites only what it measured itself — which base the work now sits
 * on, which commit contains it, and when this artifact was produced — so the
 * parent's unchanged bindings (`base_commit` must equal the authorization base,
 * `commit` must equal worktree HEAD, and the git diff between them must stay
 * inside `allowed_files`) can all be satisfied honestly. Everything the agent
 * reported about its work is carried through untouched, and the lane's original
 * bindings are preserved under `lane_provenance` so the rewrite is auditable.
 */
export function rebindLaneHandoff(laneHandoff, binding = {}) {
  const source = laneHandoff && typeof laneHandoff === "object" ? laneHandoff : {};
  const rebound = { ...source };
  rebound.run_id = binding.runId || source.run_id;
  rebound.base_commit = binding.base || null;
  rebound.commit = binding.commit || null;
  rebound.created_at = binding.now || new Date().toISOString();
  rebound.lane_provenance = {
    version: LANE_VERSION,
    lane: binding.lane || null,
    lane_branch: binding.branch || null,
    lane_base_commit: source.base_commit || null,
    lane_commit: source.commit || null,
    lane_created_at: source.created_at || null,
    rebased_onto: binding.base || null,
    joined_commit: binding.commit || null,
  };
  return rebound;
}

/** Human-readable wave report. */
export function formatLaneEligibility(result) {
  const lines = [];
  lines.push(`lane wave (max concurrency ${result.max_concurrency})`);
  if (result.wave.length === 0) {
    lines.push("  eligible: none");
  } else {
    for (const unit of result.wave) {
      lines.push(`  ${unit.id} — ${unit.allowed_files.join(", ")}`);
    }
  }
  if (result.excluded.length > 0) {
    lines.push("excluded:");
    for (const entry of result.excluded) {
      lines.push(`  ${entry.id} — ${entry.reason}${entry.detail ? ` (${entry.detail})` : ""}`);
    }
  }
  for (const error of result.errors || []) lines.push(`error: ${error}`);
  lines.push(
    result.parallel
      ? `parallel: ${result.wave.length} lanes may run concurrently`
      : "parallel: no — run the unit sequentially",
  );
  return lines.join("\n");
}
