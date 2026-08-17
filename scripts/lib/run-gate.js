/**
 * Run-state gate reminders for orchestrator sessions.
 * Used by the OpenCode plugin to discourage self-implementation.
 */

const TERMINAL_RUN_STATES = new Set(["COMPLETED", "FAILED"]);

const PRE_IMPLEMENTING = new Set([
  "CREATED",
  "CLASSIFIED",
  "PLANNED",
  "GRAPH_READY",
  "BLAST_READY",
]);

const IMPLEMENTING_STATES = new Set(["IMPLEMENTING", "DIRECT_IMPLEMENTING"]);

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
 * @returns {string | null}
 */
export function buildRunGateReminder(activeRun) {
  const { state, run_id: runId } = resolveState(activeRun);
  if (!state) {
    return [
      "## Nexus Delegation Gate",
      "STOP: No active Nexus run. Before production edits:",
      "1. nexus project-init  (once per repo)",
      "2. nexus run init --run-id <id>",
      "3. Complete classify → plan → graph → blast → IMPLEMENTING gates",
      "4. Dispatch implementer via Task tool — orchestrator must NOT edit production code.",
    ].join("\n");
  }

  if (TERMINAL_RUN_STATES.has(state)) {
    return null;
  }

  if (PRE_IMPLEMENTING.has(state)) {
    return [
      "## Nexus Delegation Gate",
      `Active run ${runId || "unknown"} is in ${state}.`,
      "STOP: Complete workflow gates before production edits.",
      "Orchestrator edits are limited to .opencode/** until IMPLEMENTING.",
      "Then dispatch implementer — do NOT self-implement.",
    ].join("\n");
  }

  if (IMPLEMENTING_STATES.has(state)) {
    return [
      "## Nexus Delegation Gate",
      `Active run ${runId || "unknown"} is in ${state}.`,
      "Dispatch implementer now. Orchestrator must NOT edit production code.",
      "Only .opencode/** edits are allowed from the orchestrator turn.",
    ].join("\n");
  }

  if (state === "VERIFYING" || state === "REVIEWING" || state === "BLOCKED") {
    return [
      "## Nexus Delegation Gate",
      `Active run ${runId || "unknown"} is in ${state}.`,
      "Do not implement production code in the orchestrator turn.",
      "Continue review/reconcile workflow or dispatch the appropriate reviewer/reconciler.",
    ].join("\n");
  }

  return null;
}

export { TERMINAL_RUN_STATES, PRE_IMPLEMENTING, IMPLEMENTING_STATES };
