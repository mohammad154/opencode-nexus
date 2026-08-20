/**
 * Deterministic next-action resolver for Nexus V5.
 * Given durable run state (+ optional worktree probes), tell the orchestrator
 * exactly what to do next — including which agent to Task-dispatch.
 */

import fs from "fs";
import path from "path";

/**
 * @typedef {object} NextAction
 * @property {boolean} ok
 * @property {string|null} run_id
 * @property {string|null} state
 * @property {string} action
 * @property {string|null} agent  - Task-dispatch target when action is dispatch_*
 * @property {string|null} skill  - skill to load when relevant
 * @property {string|null} command - suggested CLI
 * @property {string} instruction - imperative one-liner for the orchestrator
 * @property {string[]} steps     - ordered checklist
 */

function planExists(worktree) {
  if (!worktree) return false;
  return fs.existsSync(path.join(worktree, ".opencode", "plans", "PLAN.md"));
}

/**
 * @param {object|null|undefined} runState - run state.json or { state, run_id }
 * @param {{ worktree?: string|null }} [opts]
 * @returns {NextAction}
 */
export function resolveNextAction(runState, opts = {}) {
  const worktree = opts.worktree || null;
  const state = runState?.state || null;
  const runId = runState?.run_id || null;
  const hasPlan = planExists(worktree);

  if (!state) {
    return {
      ok: true,
      run_id: null,
      state: null,
      action: "init_run",
      agent: null,
      skill: "using-nexus",
      command: "nexus project-init && nexus run init --run-id <id>",
      instruction:
        "No active run. Initialize the project/run, then start brainstorming.",
      steps: [
        "nexus project-init (once per repo)",
        "nexus run init --run-id <id>",
        "Load skill: brainstorming",
        "nexus run transition --to BRAINSTORMING",
      ],
    };
  }

  switch (state) {
    case "CREATED":
      return {
        ok: true,
        run_id: runId,
        state,
        action: "brainstorm",
        agent: null,
        skill: "brainstorming",
        command: "nexus run transition --to BRAINSTORMING",
        instruction:
          "Start brainstorming (ask the user only if requirements are ambiguous).",
        steps: [
          "Load skill: brainstorming",
          "nexus run transition --to BRAINSTORMING",
          "If ambiguous → WAITING_FOR_USER with a concrete question",
          "Else write PLAN.md via writing-plans, then PLANNED",
        ],
      };

    case "BRAINSTORMING":
      if (!hasPlan) {
        return {
          ok: true,
          run_id: runId,
          state,
          action: "write_plan",
          agent: null,
          skill: "writing-plans",
          command: null,
          instruction:
            "Enough information? If yes, write .opencode/plans/PLAN.md then transition to PLANNED. If not, ask one concrete question (WAITING_FOR_USER).",
          steps: [
            "If ambiguous: nexus run transition --to WAITING_FOR_USER --json '{\"question\":\"...\"}'",
            "Else: Load skill: writing-plans → create .opencode/plans/PLAN.md",
            "nexus run transition --to PLANNED",
          ],
        };
      }
      return {
        ok: true,
        run_id: runId,
        state,
        action: "transition",
        agent: null,
        skill: "writing-plans",
        command: "nexus run transition --to PLANNED",
        instruction: "PLAN.md exists. Transition to PLANNED.",
        steps: ["nexus run transition --to PLANNED"],
      };

    case "WAITING_FOR_USER":
      return {
        ok: true,
        run_id: runId,
        state,
        action: "await_user",
        agent: null,
        skill: "brainstorming",
        command: null,
        instruction:
          "Waiting for the user's answer. After they reply, return to BRAINSTORMING and continue.",
        steps: [
          "Do not implement or dispatch agents",
          "After user answers: nexus run transition --to BRAINSTORMING",
        ],
      };

    case "PLANNED":
      return {
        ok: true,
        run_id: runId,
        state,
        action: "pre_impact",
        agent: null,
        skill: "impact-analysis",
        command:
          "nexus impact --json --targets <planned files> && nexus run transition --to TASK_IMPACT_READY",
        instruction:
          "Run fresh pre-impact for the next task, then transition to TASK_IMPACT_READY.",
        steps: [
          "Load skill: impact-analysis",
          "nexus impact --json --targets <files for current task>",
          "nexus run transition --to TASK_IMPACT_READY --json '{...impact...}'",
        ],
      };

    case "TASK_IMPACT_READY":
      return {
        ok: true,
        run_id: runId,
        state,
        action: "transition_then_dispatch",
        agent: "implementer",
        skill: "orchestrating",
        command:
          "nexus run transition --to IMPLEMENTING --branch <b> --acceptance '…'",
        instruction:
          "Transition to IMPLEMENTING, then Task-dispatch the implementer with pre-impact context. Do NOT write production code yourself.",
        steps: [
          "nexus run transition --to IMPLEMENTING --branch <b> --acceptance 'c1|c2'",
          "Task-dispatch agent: implementer (pass impact dependents/callers/tests)",
        ],
      };

    case "IMPLEMENTING":
      return {
        ok: true,
        run_id: runId,
        state,
        action: "dispatch_implementer",
        agent: "implementer",
        skill: "orchestrating",
        command: null,
        instruction:
          "REQUIRED NOW: Task-dispatch implementer. Orchestrator must not edit production files.",
        steps: [
          "Task-dispatch agent: implementer",
          "Wait for .opencode/handoffs/<id>-implementer.json (DONE*)",
          "Then: nexus run transition --to VERIFYING --json '{\"implementer_handoff\":{...}}'",
        ],
      };

    case "VERIFYING":
      return {
        ok: true,
        run_id: runId,
        state,
        action: "transition",
        agent: null,
        skill: "orchestrating",
        command: "nexus run transition --to REVIEWING",
        instruction:
          "Verification/post-impact is in progress or done. Transition to REVIEWING, then dispatch reviewer.",
        steps: [
          "Ensure VERIFYING gates passed (provider verification + post-impact)",
          "nexus run transition --to REVIEWING",
          "Next: Task-dispatch agent: reviewer",
        ],
      };

    case "REVIEWING":
      return {
        ok: true,
        run_id: runId,
        state,
        action: "dispatch_reviewer",
        agent: "reviewer",
        skill: "orchestrating",
        command: null,
        instruction:
          "REQUIRED NOW: Task-dispatch reviewer. On REQUEST_CHANGES → fresh pre-impact → implementer again (do not ask the user to fix).",
        steps: [
          "Task-dispatch agent: reviewer",
          "If APPROVED and more tasks: TASK_IMPACT_READY with next_task + fresh impact",
          "If APPROVED and done: nexus run transition --to FINAL_VERIFYING --json '{\"review_handoff\":{...}}'",
          "If REQUEST_CHANGES: fresh nexus impact → TASK_IMPACT_READY → implementer → reviewer",
        ],
      };

    case "FINAL_VERIFYING":
      return {
        ok: true,
        run_id: runId,
        state,
        action: "transition",
        agent: null,
        skill: "finishing-a-development-branch",
        command: "nexus run transition --to COMPLETED",
        instruction:
          "Run final verification and transition to COMPLETED, then finish the branch.",
        steps: [
          "nexus run transition --to COMPLETED",
          "Load skill: finishing-a-development-branch",
        ],
      };

    case "COMPLETED":
      return {
        ok: true,
        run_id: runId,
        state,
        action: "done",
        agent: null,
        skill: "finishing-a-development-branch",
        command: null,
        instruction: "Run is COMPLETED. Finish/merge/cleanup as needed.",
        steps: ["Load skill: finishing-a-development-branch if not done"],
      };

    case "BLOCKED":
      return {
        ok: true,
        run_id: runId,
        state,
        action: "reconcile",
        agent: null,
        skill: "reconcile",
        command: `nexus run resume --run-id ${runId || "<id>"}`,
        instruction:
          "Run is BLOCKED. Load reconcile, fix the block_reason, then resume only to blocked_from.",
        steps: [
          "Load skill: reconcile",
          `Read block_code/block_reason on run ${runId || "unknown"}`,
          "Fix evidence, then nexus run resume / transition back to blocked_from",
        ],
      };

    case "FAILED":
      return {
        ok: true,
        run_id: runId,
        state,
        action: "done",
        agent: null,
        skill: "reconcile",
        command: null,
        instruction: "Run FAILED (terminal). Start a new run if continuing.",
        steps: ["Inspect failure reason", "nexus run init --run-id <new-id> if retrying"],
      };

    default:
      return {
        ok: false,
        run_id: runId,
        state,
        action: "unknown_state",
        agent: null,
        skill: "using-nexus",
        command: "nexus run status",
        instruction: `Unknown state "${state}". Inspect the run and reconcile.`,
        steps: ["nexus run status", "nexus run inspect", "Load skill: reconcile if needed"],
      };
  }
}

/**
 * Format next-action as an orchestrator injection block.
 * @param {NextAction} next
 */
export function formatNextActionInjection(next) {
  const lines = [
    "## Nexus Next Action",
    `- state: ${next.state || "none"}`,
    `- run_id: ${next.run_id || "none"}`,
    `- action: ${next.action}`,
  ];
  if (next.agent) {
    lines.push(`- REQUIRED_DISPATCH: ${next.agent}`);
  }
  if (next.skill) {
    lines.push(`- skill: ${next.skill}`);
  }
  if (next.command) {
    lines.push(`- command: ${next.command}`);
  }
  lines.push(`- do_now: ${next.instruction}`);
  if (Array.isArray(next.steps) && next.steps.length) {
    lines.push("- steps:");
    for (const step of next.steps) {
      lines.push(`  - ${step}`);
    }
  }
  return lines.join("\n");
}

/**
 * Merge next-action into the delegation gate reminder text.
 */
export function appendNextActionToGate(gateText, next) {
  const block = formatNextActionInjection(next);
  if (!gateText) {
    return `## Nexus Delegation Gate\n${block}`;
  }
  return `${gateText}\n\n${block}`;
}
