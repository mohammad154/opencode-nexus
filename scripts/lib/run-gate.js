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
      "DO NOW: No active Nexus run. Before production edits:",
      "1. nexus project-init  (once per repo)",
      "2. nexus run init --run-id <id>",
      "3. Complete brainstorm → plan → pre-impact → IMPLEMENTING gates",
      "4. Dispatch implementer via Task tool — orchestrator must NOT edit production code.",
      "Hint: run `nexus next` anytime to see the deterministic next step.",
    ].join("\n");
  } else if (state === "COMPLETED") {
    gate = [
      "## Nexus Completion Gate",
      `Run ${runId || "unknown"} is COMPLETED. Continue branch finalization now; do not wait for another user message.`,
      "Load finishing-a-development-branch and follow the selected merge/cleanup policy.",
      "Under the default always_to_base policy, finish the local merge and guarded cleanup automatically.",
      "Ask only for merge_policy: prompt or a critical irreversible/external operation (push, force-discard, destructive migration, secrets, deploy, or scope change).",
    ].join("\n");
  } else if (state === "FAILED") {
    gate = [
      "## Nexus Run Gate",
      `Run ${runId || "unknown"} is FAILED. Inspect the recorded failure and reconcile or start a new run; do not silently retry destructive work.`,
    ].join("\n");
  } else if (PRE_IMPLEMENTING.has(state)) {
    gate = [
      "## Nexus Delegation Gate",
      `Active run ${runId || "unknown"} is in ${state}.`,
      "DO NOW: Complete workflow gates before production edits; continue automatically after each passing gate.",
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
  } else if (state === "VERIFYING" || state === "FINAL_VERIFYING") {
    gate = [
      "## Nexus Delegation Gate",
      `Active run ${runId || "unknown"} is in ${state}.`,
      "Do not implement production code, dispatch a reviewer, or advance the state until the deterministic verification status is PASSED.",
      "Follow Nexus Next: run or resume `nexus verify`; timeout never means redispatch implementer.",
    ].join("\n");
  } else if (state === "REVIEWING" || state === "FINAL_REVIEWING") {
    gate = [
      "## Nexus Delegation Gate",
      `Active run ${runId || "unknown"} is in ${state}.`,
      "Do not implement production code in the orchestrator turn.",
      "Continue the review workflow or dispatch the reviewer / re-impact for REQUEST_CHANGES automatically.",
    ].join("\n");
  } else if (state === "BLOCKED") {
    gate = [
      "## Nexus Delegation Gate",
      `Active run ${runId || "unknown"} is BLOCKED.`,
      "Load reconcile, inspect the recorded block, and repair evidence before resuming; do not guess or dispatch around the block.",
    ].join("\n");
  }

  const runForNext =
    typeof activeRun === "string"
      ? { state: activeRun, run_id: runId }
      : activeRun || null;
  const next = resolveNextAction(runForNext, { worktree });
  if (next.action === "block_for_agent_budget") {
    gate = [
      "## Nexus Delegation Gate",
      `Active run ${runId || "unknown"} cannot dispatch another implementer.`,
      "STOP: the agent-call budget is exhausted. Record BLOCKED and reconcile; do not start another subagent.",
    ].join("\n");
  } else if (next.action === "block_for_fix_loop") {
    gate = [
      "## Nexus Delegation Gate",
      `Active run ${runId || "unknown"} has exhausted its reviewer fix-loop budget.`,
      "DO NOW: Transition to BLOCKED and reconcile; do not redispatch a reviewer or implementer.",
    ].join("\n");
  }

  if (!gate) return null;
  if (!includeNext) return gate;
  return appendNextActionToGate(gate, next);
}

export { TERMINAL_RUN_STATES, PRE_IMPLEMENTING, IMPLEMENTING_STATES };
