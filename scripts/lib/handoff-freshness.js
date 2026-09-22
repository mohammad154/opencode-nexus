/**
 * Canonical handoff consumability (PR7).
 *
 * Agent output may be consumed by automation only when the agent produced it
 * *for the current authorization*. Otherwise a file left over from a previous
 * fix-loop attempt could let automation skip the agent entirely, or an
 * already-consumed handoff could be replayed into a second gate.
 *
 * The primary signals are commit bindings, not timestamps:
 * - an implementer handoff must be based on the commit the current IMPLEMENTING
 *   authorization recorded, and its commit must be the current worktree HEAD;
 * - a reviewer handoff must have reviewed the current worktree HEAD in the scope
 *   the current state requires.
 * Recency is a secondary guard with tolerance, because handoff timestamps are
 * agent-written and may be truncated to whole seconds.
 *
 * This module answers "may automation consume this file?" only. Admissibility,
 * binding, and every other gate check stay in the state machine.
 */

import fs from "fs";
import path from "path";
import { validateContainedPath } from "./filesystem-boundary.js";

/** Handoff timestamps are agent-written; tolerate second-level truncation. */
export const HANDOFF_RECENCY_TOLERANCE_MS = 2000;

/** Timestamp (ms) of the most recent recorded entry into a state. */
export function enteredStateAt(state, stateName = state?.state) {
  const transitions = Array.isArray(state?.transitions) ? state.transitions : [];
  for (let i = transitions.length - 1; i >= 0; i -= 1) {
    if (transitions[i]?.to === stateName) {
      const at = Date.parse(transitions[i]?.at || "");
      return Number.isFinite(at) ? at : null;
    }
  }
  return null;
}

/** Canonical handoff location for a role. */
export function handoffPath(runId, role) {
  if (!runId) return null;
  return path.join(".opencode", "handoffs", `${runId}-${role}.json`);
}

/** Read the canonical handoff for a role. Never throws. */
export function readHandoffFile(worktree, state, role) {
  const relative = handoffPath(state?.run_id, role);
  if (!worktree || !relative) return { path: relative, data: null, reason: "MISSING" };
  const absolute = path.resolve(worktree, relative);
  const boundary = validateContainedPath(worktree, absolute, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  if (!boundary.ok || !boundary.exists) {
    return { path: relative, data: null, reason: "MISSING" };
  }
  try {
    return { path: relative, data: JSON.parse(fs.readFileSync(absolute, "utf8")), reason: null };
  } catch {
    return { path: relative, data: null, reason: "UNPARSABLE" };
  }
}

/** An implementer handoff that reports finished work. */
export function isImplementerDone(data) {
  return String(data?.status || "").toUpperCase().startsWith("DONE");
}

function notAncient(data, state) {
  const createdAt = Date.parse(data?.created_at || "");
  if (!Number.isFinite(createdAt)) return "NO_CREATED_AT";
  const enteredAt = enteredStateAt(state);
  if (enteredAt != null && createdAt < enteredAt - HANDOFF_RECENCY_TOLERANCE_MS) {
    return "PREDATES_CURRENT_STATE";
  }
  return null;
}

function alreadyConsumed(data, consumed) {
  if (!consumed || typeof consumed !== "object") return false;
  return (
    consumed.created_at === data.created_at &&
    (consumed.commit || null) === (data.commit || null) &&
    (consumed.reviewed_commit || null) === (data.reviewed_commit || null)
  );
}

/**
 * May automation feed this implementer handoff to the VERIFYING gate?
 *
 * @param {object} state run state (must be in IMPLEMENTING for a positive answer)
 * @param {string|null} headCommit current worktree HEAD
 */
export function consumableImplementerHandoff(worktree, state, headCommit) {
  const file = readHandoffFile(worktree, state, "implementer");
  const answer = (reason) => ({ ...file, consumable: false, reason });
  if (!file.data) return answer(file.reason || "MISSING");
  const data = file.data;
  if (data.run_id && state?.run_id && data.run_id !== state.run_id) {
    return answer("OTHER_RUN");
  }
  if (!isImplementerDone(data)) return answer("NOT_DONE");
  if (!headCommit || data.commit !== headCommit) return answer("COMMIT_NOT_CURRENT_HEAD");
  // The authorization's base commit is the anti-replay signal: a handoff from an
  // earlier attempt was based on an earlier commit.
  const authorizedBase = state?.head_commit || null;
  if (authorizedBase && data.base_commit && data.base_commit !== authorizedBase) {
    return answer("BASE_NOT_CURRENT_AUTHORIZATION");
  }
  if (alreadyConsumed(data, state?.last_implementer_handoff)) {
    return answer("ALREADY_CONSUMED");
  }
  const ancient = notAncient(data, state);
  if (ancient) return answer(ancient);
  return { ...file, consumable: true, reason: null };
}

/**
 * May automation feed this reviewer handoff to the next gate?
 *
 * @param {string} scope "task" or "final" — the scope the current state requires
 */
export function consumableReviewerHandoff(worktree, state, headCommit, scope) {
  const file = readHandoffFile(worktree, state, "reviewer");
  const answer = (reason) => ({ ...file, consumable: false, reason });
  if (!file.data) return answer(file.reason || "MISSING");
  const data = file.data;
  if (data.run_id && state?.run_id && data.run_id !== state.run_id) {
    return answer("OTHER_RUN");
  }
  if ((data.review_scope || "task") !== scope) return answer("SCOPE_MISMATCH");
  if (!data.verdict) return answer("NO_VERDICT");
  // A review is bound to the commit it reviewed: after a fix loop the tree has
  // moved, so the previous verdict is no longer about this code.
  if (!headCommit || data.reviewed_commit !== headCommit) {
    return answer("REVIEWED_COMMIT_NOT_CURRENT_HEAD");
  }
  if (alreadyConsumed(data, state?.last_review_handoff)) return answer("ALREADY_CONSUMED");
  const ancient = notAncient(data, state);
  if (ancient) return answer(ancient);
  return { ...file, consumable: true, reason: null };
}
