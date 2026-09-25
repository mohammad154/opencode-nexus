/**
 * Lane runtime: isolated worktrees for concurrent implementers, and a join that
 * hands their work to the parent run as ordinary, fully bound evidence (PR9).
 *
 * Placement and publication rules that matter for correctness:
 *
 * 1. Lane records live under `.opencode/lanes/`, not under `.opencode/runs/`.
 *    The control plane snapshots the orchestrator-owned runtime at IMPLEMENTING
 *    and compares it at VERIFYING, so a lane writing into the protected tree
 *    during that window would (correctly) look like tampering. Lanes are not
 *    gate evidence — the rebased handoff and the parent's own measurements are —
 *    so they belong outside it.
 *
 * 2. A lane never writes to the parent's run state. It has no state machine and
 *    authorizes nothing. The only thing a join hands over is an implementer
 *    handoff, which the parent then consumes through its normal gates.
 *
 * 3. Ledger mutations hold the lane file lock and publish the next document
 *    with a rename. A missing ledger is empty. A corrupt, partial, or
 *    symlinked ledger is a refusal — it is never read back as "no lanes",
 *    and it is never overwritten.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_LANE_CONCURRENCY,
  LANE_STATUS,
  LANE_VERSION,
  findLane,
  laneBranch,
  laneEligibility,
  laneHandoffBindingErrors,
  laneId,
  laneJoinErrors,
  laneRecords,
  openLanes,
  rebindLaneHandoff,
} from "./lanes.js";
import { createTaskWorktree, removeTaskWorktree } from "./worktree.js";
import { boundaryError, validateContainedPath } from "./filesystem-boundary.js";
import { withFileLock } from "./lock.js";

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function revParse(cwd, rev = "HEAD") {
  const result = git(cwd, ["rev-parse", rev]);
  if (result.status !== 0) return null;
  const sha = String(result.stdout || "").trim();
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

function isAncestor(cwd, ancestor, descendant) {
  if (!ancestor || !descendant) return null;
  const result = git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

function changedFiles(cwd, base, head) {
  if (!base || !head) return null;
  const result = git(cwd, ["diff", "--name-only", `${base}..${head}`]);
  if (result.status !== 0) return null;
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Lane ledger path for a run. Outside the control-plane protected tree. */
export function laneFilePath(worktree, runId) {
  return path.join(worktree, ".opencode", "lanes", `${String(runId || "run")}.json`);
}

function ledgerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertLaneBoundary(worktree, file) {
  const boundary = validateContainedPath(worktree, file, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  if (!boundary.ok) {
    const error = boundaryError("lane ledger path", boundary);
    error.code = "LANE_LEDGER_BOUNDARY";
    throw error;
  }
  return boundary;
}

function ledgerRefusal(error) {
  if (
    error?.code === "LANE_LEDGER_CORRUPT" ||
    error?.code === "LANE_LEDGER_UNREADABLE" ||
    error?.code === "LANE_LEDGER_BOUNDARY"
  ) {
    return {
      ok: false,
      code: error.code,
      errors: [String(error.message || error)],
    };
  }
  if (
    typeof error?.message === "string" &&
    error.message.startsWith("could not acquire lock:")
  ) {
    return { ok: false, code: "LANE_LEDGER_LOCKED", errors: [error.message] };
  }
  return null;
}

/**
 * Read the ledger. A missing file is an empty ledger. Anything unreadable —
 * a partial write, corrupt JSON, or a path that fails the symlink check — throws
 * instead of looking like "no lanes".
 */
function readLaneSnapshot(worktree, runId) {
  const file = laneFilePath(worktree, runId);
  const boundary = assertLaneBoundary(worktree, file);
  if (!boundary.exists) {
    return { version: LANE_VERSION, run_id: runId, lanes: [] };
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw ledgerError(
      "LANE_LEDGER_UNREADABLE",
      `lane ledger could not be read: ${error.message}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw ledgerError(
      "LANE_LEDGER_CORRUPT",
      "lane ledger is corrupt or partial and cannot be treated as empty",
    );
  }
  const lanes = parsed?.lanes;
  const recordsIntact =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Array.isArray(lanes) &&
    lanes.every(
      (lane) =>
        lane && typeof lane === "object" && typeof lane.unit === "string",
    );
  if (!recordsIntact) {
    throw ledgerError(
      "LANE_LEDGER_CORRUPT",
      "lane ledger is corrupt or partial and cannot be treated as empty",
    );
  }
  return {
    version: parsed.version || LANE_VERSION,
    run_id: parsed.run_id || runId,
    lanes: laneRecords(parsed),
  };
}

export function readLaneFile(worktree, runId) {
  return readLaneSnapshot(worktree, runId);
}

function writeLaneFileUnlocked(worktree, runId, laneFile) {
  const file = laneFilePath(worktree, runId);
  assertLaneBoundary(worktree, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assertLaneBoundary(worktree, file);
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  assertLaneBoundary(worktree, tmp);
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ ...laneFile, version: LANE_VERSION, run_id: runId }, null, 2)}\n`,
  );
  try {
    assertLaneBoundary(worktree, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  fs.renameSync(tmp, file);
  return file;
}

function replaceLane(laneFile, runId, record) {
  const lanes = laneFile.lanes.filter((lane) => lane.unit !== record.unit);
  lanes.push(record);
  lanes.sort((a, b) => String(a.unit).localeCompare(String(b.unit)));
  return { ...laneFile, version: LANE_VERSION, run_id: runId, lanes };
}

/**
 * Serialize a read-modify-write of the ledger. The mutator runs while the lock
 * is held and sees the ledger just read under that lock. Return `{ ledger, value }`
 * to publish `ledger` by rename; return any other value to leave the file untouched.
 */
function mutateLanes(worktree, runId, mutator) {
  const file = laneFilePath(worktree, runId);
  assertLaneBoundary(worktree, file);
  return withFileLock(file, () => {
    const current = readLaneSnapshot(worktree, runId);
    const result = mutator(current);
    if (result && Object.prototype.hasOwnProperty.call(result, "ledger")) {
      writeLaneFileUnlocked(worktree, runId, result.ledger);
      return result.value;
    }
    return result;
  });
}

function refuseLedger(error) {
  const refused = ledgerRefusal(error);
  if (refused) return refused;
  throw error;
}

/** The deterministic wave, with lanes already open taken into account. */
export function planLanes(worktree, state, options = {}) {
  try {
    const laneFile = readLaneFile(worktree, state?.run_id);
    return {
      ...laneEligibility(state, {
        ...options,
        activeLanes: openLanes(laneFile),
      }),
      open_lanes: openLanes(laneFile).map((lane) => lane.unit),
    };
  } catch (error) {
    const refused = ledgerRefusal(error);
    if (!refused) throw error;
    const requested = Number(
      options.maxConcurrency ?? DEFAULT_LANE_CONCURRENCY,
    );
    return {
      ok: false,
      version: LANE_VERSION,
      max_concurrency:
        Number.isInteger(requested) && requested >= 1
          ? requested
          : DEFAULT_LANE_CONCURRENCY,
      wave: [],
      excluded: [],
      open_lanes: [],
      errors: refused.errors,
      parallel: false,
      code: refused.code,
    };
  }
}

/**
 * Open a lane for one unit: an isolated worktree and branch at the parent tip.
 *
 * Eligibility is re-derived here rather than trusted from a caller, so `start`
 * cannot open a lane for a unit the schedule refuses. The eligibility check and
 * the ledger reservation are one locked update, so two starts cannot both pass
 * a concurrency limit against the same snapshot.
 */
export function startLane(worktree, state, unitId, options = {}) {
  const runId = state?.run_id;
  const base = revParse(worktree, "HEAD");
  if (!base) {
    return {
      ok: false,
      code: "LANE_NO_BASE",
      errors: ["cannot resolve the parent tip"],
    };
  }
  const lane = laneId(unitId);
  const branch = laneBranch(runId, unitId);
  if (!lane || !branch) {
    return {
      ok: false,
      code: "LANE_BAD_ID",
      errors: [
        `unit id ${unitId} cannot be expressed as a lane worktree and branch`,
      ],
    };
  }

  let reserved;
  try {
    reserved = mutateLanes(worktree, runId, (laneFile) => {
      const existing = findLane(laneFile, unitId);
      if (existing && existing.status !== LANE_STATUS.ABANDONED) {
        return {
          ok: false,
          code: "LANE_EXISTS",
          errors: [
            `lane for ${unitId} already exists with status ${existing.status}`,
          ],
          lane: existing,
        };
      }
      const plan = {
        ...laneEligibility(state, {
          ...options,
          activeLanes: openLanes(laneFile),
        }),
        open_lanes: openLanes(laneFile).map((entry) => entry.unit),
      };
      const eligible = plan.wave.find((unit) => unit.id === unitId);
      if (!eligible) {
        const excluded = plan.excluded.find((entry) => entry.id === unitId);
        return {
          ok: false,
          code: "LANE_NOT_ELIGIBLE",
          errors: [
            excluded
              ? `unit ${unitId} cannot run in a lane: ${excluded.reason}${excluded.detail ? ` (${excluded.detail})` : ""}`
              : `unit ${unitId} is not in the current lane wave`,
            ...plan.errors,
          ],
          plan,
        };
      }
      const record = {
        unit: unitId,
        lane,
        branch,
        path: null,
        base_commit: base,
        status: LANE_STATUS.RUNNING,
        allowed_files: eligible.allowed_files,
        acceptance_criteria: eligible.acceptance_criteria,
        started_at: new Date().toISOString(),
        joined_at: null,
        joined_commit: null,
      };
      return {
        ledger: replaceLane(laneFile, runId, record),
        value: {
          ok: true,
          lane: record,
          plan,
          previous:
            existing?.status === LANE_STATUS.ABANDONED ? existing : null,
        },
      };
    });
  } catch (error) {
    return refuseLedger(error);
  }
  if (!reserved.ok) return reserved;

  const created = createTaskWorktree(worktree, lane, { branch, baseCommit: base });
  if (!created.ok) {
    try {
      return mutateLanes(worktree, runId, (laneFile) => {
        const current = findLane(laneFile, unitId);
        const stillOurs =
          current &&
          current.status === LANE_STATUS.RUNNING &&
          current.path == null &&
          current.base_commit === base &&
          current.started_at === reserved.lane.started_at;
        const failure = {
          ok: false,
          code: created.code || "LANE_WORKTREE_FAILED",
          errors: [created.error || "could not create the lane worktree"],
        };
        if (!stillOurs) return failure;
        const ledger = reserved.previous
          ? replaceLane(laneFile, runId, reserved.previous)
          : {
              ...laneFile,
              run_id: runId,
              lanes: laneFile.lanes.filter((entry) => entry.unit !== unitId),
            };
        return { ledger, value: failure };
      });
    } catch (error) {
      return refuseLedger(error);
    }
  }

  fs.mkdirSync(path.join(created.path, ".opencode", "handoffs"), { recursive: true });
  try {
    return mutateLanes(worktree, runId, (laneFile) => {
      const current = findLane(laneFile, unitId);
      if (
        !current ||
        current.status !== LANE_STATUS.RUNNING ||
        current.started_at !== reserved.lane.started_at
      ) {
        return {
          ok: false,
          code: "LANE_CHANGED",
          errors: [
            `lane for ${unitId} changed while its worktree was being created`,
          ],
        };
      }
      const record = { ...current, path: created.path };
      return {
        ledger: replaceLane(laneFile, runId, record),
        value: { ok: true, lane: record, plan: reserved.plan },
      };
    });
  } catch (error) {
    return refuseLedger(error);
  }
}

/** Per-lane status, measured from git rather than reported. */
export function laneStatus(worktree, state) {
  const runId = state?.run_id;
  let laneFile;
  try {
    laneFile = readLaneFile(worktree, runId);
  } catch (error) {
    const refused = ledgerRefusal(error);
    if (!refused) throw error;
    return { ...refused, run_id: runId, parent_tip: null, lanes: [] };
  }
  const parentTip = revParse(worktree, "HEAD");
  const lanes = laneFile.lanes.map((lane) => {
    const tip = lane.path && fs.existsSync(lane.path) ? revParse(lane.path, "HEAD") : null;
    const advanced = Boolean(tip && lane.base_commit && tip !== lane.base_commit);
    const handoff = readLaneHandoff(lane, runId);
    return {
      ...lane,
      worktree_present: Boolean(lane.path && fs.existsSync(lane.path)),
      tip_commit: tip,
      advanced,
      has_handoff: Boolean(handoff),
      handoff_status: handoff?.status || null,
      // "Implemented" is a measured fact: a commit beyond the lane base plus a
      // DONE handoff. The lane cannot declare itself ready.
      ready_to_join:
        lane.status === LANE_STATUS.RUNNING &&
        advanced &&
        Boolean(handoff) &&
        String(handoff?.status || "").toUpperCase().startsWith("DONE"),
    };
  });
  return { run_id: runId, parent_tip: parentTip, lanes };
}

function readLaneHandoff(lane, runId) {
  if (!lane?.path) return null;
  const file = path.join(lane.path, ".opencode", "handoffs", `${runId}-implementer.json`);
  const boundary = validateContainedPath(lane.path, file, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  if (!boundary.ok || !boundary.exists) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Join a lane: rebase its work onto the parent tip, prove the result, and write
 * the re-bound implementer handoff the parent will consume.
 *
 * The rebase happens inside the lane worktree and the parent branch is advanced
 * only after every guard passes, so a refused join leaves the parent untouched.
 */
export function joinLane(worktree, state, unitId, options = {}) {
  const runId = state?.run_id;
  let laneFile;
  try {
    laneFile = readLaneFile(worktree, runId);
  } catch (error) {
    return refuseLedger(error);
  }
  const lane = findLane(laneFile, unitId);
  if (!lane) {
    return { ok: false, code: "LANE_MISSING", errors: [`no lane for unit ${unitId}`] };
  }
  if (lane.status === LANE_STATUS.JOINED) {
    return { ok: false, code: "LANE_ALREADY_JOINED", errors: [`lane ${unitId} is already joined`] };
  }
  if (lane.status === LANE_STATUS.ABANDONED) {
    return { ok: false, code: "LANE_ABANDONED", errors: [`lane ${unitId} was abandoned`] };
  }
  if (!lane.path || !fs.existsSync(lane.path)) {
    return { ok: false, code: "LANE_WORKTREE_GONE", errors: [`lane worktree for ${unitId} is missing`] };
  }

  const parentTip = revParse(worktree, "HEAD");
  const parentBranch = currentBranch(worktree);
  if (!parentTip || !parentBranch) {
    return {
      ok: false,
      code: "LANE_PARENT_UNRESOLVED",
      errors: ["cannot resolve the parent branch and tip"],
    };
  }

  const laneHandoff = readLaneHandoff(lane, runId);
  const laneTip = revParse(lane.path, "HEAD");
  const handoffBindingErrors = laneHandoffBindingErrors({
    runId,
    unit: unitId,
    laneBaseCommit: lane.base_commit,
    laneTip,
    laneHandoff,
  });
  if (handoffBindingErrors.length > 0) {
    return {
      ok: false,
      code: "LANE_JOIN_REFUSED",
      errors: handoffBindingErrors,
      lane,
      parent_tip: parentTip,
    };
  }

  // Rebase the lane's commits onto the parent tip. This is what lets the parent
  // apply its unchanged bindings: afterwards the work sits directly on the
  // commit the parent authorized.
  let conflicted = false;
  let rebaseError = null;
  if (laneTip && laneTip !== parentTip) {
    // Rebase the checked-out lane branch itself. Naming HEAD as the branch
    // argument would leave the lane detached and its branch ref stale.
    const rebase = git(lane.path, ["rebase", "--onto", parentTip, lane.base_commit]);
    if (rebase.status !== 0) {
      conflicted = true;
      rebaseError = String(rebase.stderr || rebase.stdout || "rebase failed").trim();
      git(lane.path, ["rebase", "--abort"]);
    }
  }

  const joinedCommit = conflicted ? null : revParse(lane.path, "HEAD");
  const diff = conflicted ? [] : changedFiles(lane.path, parentTip, joinedCommit) || [];
  const errors = laneJoinErrors({
    unit: unitId,
    allowedFiles: lane.allowed_files,
    diffFiles: diff,
    conflicted,
    parentBase: parentTip,
    joinedCommit,
    ancestor: conflicted ? null : isAncestor(lane.path, parentTip, joinedCommit),
    laneHandoff,
  });
  if (rebaseError) errors.push(`rebase output: ${rebaseError.split(/\r?\n/)[0]}`);

  if (errors.length > 0) {
    return { ok: false, code: "LANE_JOIN_REFUSED", errors, lane, parent_tip: parentTip };
  }

  // Advance the parent branch to the rebased work. Fast-forward only: anything
  // else would mean the parent moved since we measured it.
  const ff = git(worktree, ["merge", "--ff-only", joinedCommit]);
  if (ff.status !== 0) {
    return {
      ok: false,
      code: "LANE_JOIN_NOT_FAST_FORWARD",
      errors: [
        `parent branch ${parentBranch} could not fast-forward to the rebased lane work (the parent moved during the join)`,
        String(ff.stderr || "").trim(),
      ].filter(Boolean),
      lane,
    };
  }

  const handoffPath = writeParentHandoff(worktree, runId, laneHandoff, {
    runId,
    base: parentTip,
    commit: joinedCommit,
    lane: lane.lane,
    branch: lane.branch,
    now: options.now || new Date().toISOString(),
  });

  const joinedAt = new Date().toISOString();
  try {
    return mutateLanes(worktree, runId, (fresh) => {
      const current = findLane(fresh, unitId);
      if (!current) {
        return {
          ok: false,
          code: "LANE_MISSING",
          errors: [`no lane for unit ${unitId}`],
        };
      }
      if (current.status === LANE_STATUS.JOINED) {
        return {
          ok: false,
          code: "LANE_ALREADY_JOINED",
          errors: [`lane ${unitId} is already joined`],
        };
      }
      if (current.status !== lane.status) {
        return {
          ok: false,
          code: "LANE_CHANGED",
          errors: [
            `lane ${unitId} changed to ${current.status} during the join`,
          ],
        };
      }
      const record = {
        ...current,
        status: LANE_STATUS.JOINED,
        joined_at: joinedAt,
        joined_commit: joinedCommit,
        joined_onto: parentTip,
        joined_files: diff,
      };
      return {
        ledger: replaceLane(fresh, runId, record),
        value: {
          ok: true,
          lane: record,
          parent_tip: parentTip,
          joined_commit: joinedCommit,
          files: diff,
          handoff_path: handoffPath,
        },
      };
    });
  } catch (error) {
    return refuseLedger(error);
  }
}

function currentBranch(worktree) {
  const result = git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (result.status !== 0) return null;
  const name = String(result.stdout || "").trim();
  return name && name !== "HEAD" ? name : null;
}

function writeParentHandoff(worktree, runId, laneHandoff, binding) {
  const rebound = rebindLaneHandoff(laneHandoff, binding);
  const file = path.join(worktree, ".opencode", "handoffs", `${runId}-implementer.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rebound, null, 2)}\n`);
  return path.relative(worktree, file);
}

/** Abandon a lane and remove its worktree. The parent branch is never touched. */
export function abortLane(worktree, state, unitId, options = {}) {
  const runId = state?.run_id;
  try {
    return mutateLanes(worktree, runId, (laneFile) => {
      const lane = findLane(laneFile, unitId);
      if (!lane) {
        return {
          ok: false,
          code: "LANE_MISSING",
          errors: [`no lane for unit ${unitId}`],
        };
      }
      if (lane.status === LANE_STATUS.JOINED) {
        return {
          ok: false,
          code: "LANE_ALREADY_JOINED",
          errors: [
            `lane ${unitId} is already joined — its work is in the parent branch and must be handled there, not by abandoning the lane`,
          ],
        };
      }
      const removed = removeTaskWorktree(worktree, lane.lane);
      if (options.keepBranch !== true && lane.branch) {
        git(worktree, ["branch", "-D", lane.branch]);
      }
      const record = {
        ...lane,
        status: LANE_STATUS.ABANDONED,
        abandoned_at: new Date().toISOString(),
        abandon_reason: options.reason || null,
      };
      return {
        ledger: replaceLane(laneFile, runId, record),
        value: {
          ok: true,
          lane: record,
          worktree_removed: removed.removed === true,
        },
      };
    });
  } catch (error) {
    return refuseLedger(error);
  }
}
