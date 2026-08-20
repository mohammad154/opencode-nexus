/**
 * Run-state gate reminders for orchestrator sessions (V5).
 */

import {
  resolveNextAction,
  appendNextActionToGate,
} from "./next-action.js";

const TERMINAL_RUN_STATES = new Set(["COMPLETED", "FAILED"]);

const PRE_IMPLEMENTING = new Set([
  "CREATED",
  "BRAINSTORMING",
  "WAITING_FOR_USER",
  "PLANNED",
  "TASK_IMPACT_READY",
]);

const IMPLEMENTING_STATES = new Set(["IMPLEMENTING"]);

function resolveState(activeRun) {
  if (typeof activeRun === "string") {
    return { state: activeRun, run_id: null };
  }
  if (activeRun && typeof activeRun === "object") {
    return { state: activeRun.state || null, run_id: activeRun.run_id || null };
  }
  return { state: null, run_id: null };
}

/**
 * @param {{ state?: string, run_id?: string } | string | null | undefined} activeRun
 * @param {{ worktree?: string|null, includeNextAction?: boolean }} [opts]
 * @returns {string | null}
 */
export function buildRunGateReminder(activeRun, opts = {}) {
  const { state, run_id: runId } = resolveState(activeRun);
  const includeNext = opts.includeNextAction !== false;
  const worktree = opts.worktree || null;

  let gate = null;

  if (!state) {
    gate = [
      "## Nexus Delegation Gate",
      "STOP: No active Nexus run. Before production edits:",
      "1. nexus project-init  (once per repo)",
      "2. nexus run init --run-id <id>",
      "3. Complete brainstorm → plan → pre-impact → IMPLEMENTING gates",
      "4. Dispatch implementer via Task tool — orchestrator must NOT edit production code.",
      "Hint: run `nexus next` anytime to see the deterministic next step.",
    ].join("\n");
  } else if (TERMINAL_RUN_STATES.has(state)) {
    return null;
  } else if (PRE_IMPLEMENTING.has(state)) {
    gate = [
      "## Nexus Delegation Gate",
      `Active run ${runId || "unknown"} is in ${state}.`,
      "STOP: Complete workflow gates before production edits.",
      "Orchestrator edits are limited to .opencode/** until IMPLEMENTING.",
      "Then dispatch implementer — do NOT self-implement.",
    ].join("\n");
  } else if (IMPLEMENTING_STATES.has(state)) {
    gate = [
      "## Nexus Delegation Gate",
      `Active run ${runId || "unknown"} is in ${state}.`,
      "Dispatch implementer now. Orchestrator must NOT edit production code.",
      "Only .opencode/** edits are allowed from the orchestrator turn.",
    ].join("\n");
  } else if (
    state === "VERIFYING" ||
    state === "REVIEWING" ||
    state === "FINAL_VERIFYING" ||
    state === "BLOCKED"
  ) {
    gate = [
      "## Nexus Delegation Gate",
      `Active run ${runId || "unknown"} is in ${state}.`,
      "Do not implement production code in the orchestrator turn.",
      "Continue review workflow or dispatch the reviewer / re-impact for REQUEST_CHANGES.",
    ].join("\n");
  }

  if (!gate) return null;
  if (!includeNext) return gate;

  const runForNext =
    typeof activeRun === "string"
      ? { state: activeRun, run_id: runId }
      : activeRun || null;
  const next = resolveNextAction(runForNext, { worktree });
  return appendNextActionToGate(gate, next);
}

export { TERMINAL_RUN_STATES, PRE_IMPLEMENTING, IMPLEMENTING_STATES };
