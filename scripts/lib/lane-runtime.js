/**
 * Lane runtime: isolated worktrees for concurrent implementers, and a join that
 * hands their work to the parent run as ordinary, fully bound evidence (PR9).
 *
 * Two placement decisions matter for correctness:
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
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
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
import { validateContainedPath } from "./filesystem-boundary.js";

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

export function readLaneFile(worktree, runId) {
  const file = laneFilePath(worktree, runId);
  const boundary = validateContainedPath(worktree, file, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  if (!boundary.ok || !boundary.exists) {
    return { version: LANE_VERSION, run_id: runId, lanes: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: parsed.version || LANE_VERSION,
      run_id: parsed.run_id || runId,
      lanes: laneRecords(parsed),
    };
  } catch {
    return { version: LANE_VERSION, run_id: runId, lanes: [] };
  }
}

function writeLaneFile(worktree, runId, laneFile) {
  const file = laneFilePath(worktree, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...laneFile, version: LANE_VERSION }, null, 2)}\n`);
  return file;
}

function upsertLane(worktree, runId, record) {
  const laneFile = readLaneFile(worktree, runId);
  const lanes = laneFile.lanes.filter((lane) => lane.unit !== record.unit);
  lanes.push(record);
  lanes.sort((a, b) => String(a.unit).localeCompare(String(b.unit)));
  const updated = { ...laneFile, run_id: runId, lanes };
  writeLaneFile(worktree, runId, updated);
  return updated;
}

/** The deterministic wave, with lanes already open taken into account. */
export function planLanes(worktree, state, options = {}) {
  const laneFile = readLaneFile(worktree, state?.run_id);
  return {
    ...laneEligibility(state, { ...options, activeLanes: openLanes(laneFile) }),
    open_lanes: openLanes(laneFile).map((lane) => lane.unit),
  };
}

/**
 * Open a lane for one unit: an isolated worktree and branch at the parent tip.
 *
 * Eligibility is re-derived here rather than trusted from a caller, so `start`
 * cannot open a lane for a unit the schedule refuses.
 */
export function startLane(worktree, state, unitId, options = {}) {
  const runId = state?.run_id;
  const existing = findLane(readLaneFile(worktree, runId), unitId);
  if (existing && existing.status !== LANE_STATUS.ABANDONED) {
    return {
      ok: false,
      code: "LANE_EXISTS",
      errors: [`lane for ${unitId} already exists with status ${existing.status}`],
      lane: existing,
    };
  }
  const plan = planLanes(worktree, state, options);
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

  const base = revParse(worktree, "HEAD");
  if (!base) {
    return { ok: false, code: "LANE_NO_BASE", errors: ["cannot resolve the parent tip"] };
  }
  const lane = laneId(unitId);
  const branch = laneBranch(runId, unitId);
  if (!lane || !branch) {
    return {
      ok: false,
      code: "LANE_BAD_ID",
      errors: [`unit id ${unitId} cannot be expressed as a lane worktree and branch`],
    };
  }

  const created = createTaskWorktree(worktree, lane, { branch, baseCommit: base });
  if (!created.ok) {
    return {
      ok: false,
      code: created.code || "LANE_WORKTREE_FAILED",
      errors: [created.error || "could not create the lane worktree"],
    };
  }

  fs.mkdirSync(path.join(created.path, ".opencode", "handoffs"), { recursive: true });

  const record = {
    unit: unitId,
    lane,
    branch,
    path: created.path,
    base_commit: base,
    status: LANE_STATUS.RUNNING,
    allowed_files: eligible.allowed_files,
    acceptance_criteria: eligible.acceptance_criteria,
    started_at: new Date().toISOString(),
    joined_at: null,
    joined_commit: null,
  };
  upsertLane(worktree, runId, record);
  return { ok: true, lane: record, plan };
}

/** Per-lane status, measured from git rather than reported. */
export function laneStatus(worktree, state) {
  const runId = state?.run_id;
  const laneFile = readLaneFile(worktree, runId);
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
  const laneFile = readLaneFile(worktree, runId);
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

  const record = {
    ...lane,
    status: LANE_STATUS.JOINED,
    joined_at: new Date().toISOString(),
    joined_commit: joinedCommit,
    joined_onto: parentTip,
    joined_files: diff,
  };
  upsertLane(worktree, runId, record);
  return {
    ok: true,
    lane: record,
    parent_tip: parentTip,
    joined_commit: joinedCommit,
    files: diff,
    handoff_path: handoffPath,
  };
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
  const lane = findLane(readLaneFile(worktree, runId), unitId);
  if (!lane) {
    return { ok: false, code: "LANE_MISSING", errors: [`no lane for unit ${unitId}`] };
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
  upsertLane(worktree, runId, record);
  return { ok: true, lane: record, worktree_removed: removed.removed === true };
}
