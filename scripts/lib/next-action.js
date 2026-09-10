/**
 * Deterministic next-action resolver for Nexus V5.
 * Given durable run state (+ optional worktree probes), tell the orchestrator
 * exactly what to do next — including which agent to Task-dispatch.
 */

import fs from "fs";
import path from "path";
import { planningModeFromEvidence } from "./planning.js";

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

function stateHasSingleUnit(runState) {
  const candidate =
    runState?.execution_units ?? runState?.units ?? runState?.tasks;
  if (Array.isArray(candidate)) return candidate.length === 1;
  if (Number.isFinite(Number(candidate))) return Number(candidate) === 1;
  if (runState?.task_count != null) return Number(runState.task_count) === 1;
  return false;
}

function stateRunPlanningMode(runState) {
  const explicit = String(runState?.planning_mode || "").trim().toLowerCase();
  if (explicit) return explicit;
  const classification = runState?.classification || {};
  return (
    planningModeFromEvidence({
      ...classification,
      ...runState,
      change_class:
        runState?.change_class || classification.change_class || classification.changeClass,
      files_changed:
        runState?.files_changed || classification.files_changed || classification.filesChanged,
      estimated_lines:
        runState?.estimated_lines ||
        classification.estimated_lines ||
        classification.estimatedLines,
    }) || ""
  );
}

function verificationStatus(runState, phase) {
  const record = runState?.verification;
  if (record && typeof record === "object" && (!record.phase || record.phase === phase)) {
    return record.status || runState?.verification_status || "PENDING";
  }
  return runState?.verification_status || "PENDING";
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
      if (
        (stateRunPlanningMode(runState) === "standard" ||
          stateRunPlanningMode(runState) === "deep") &&
        !runState.plan_advisor &&
        !runState.plan_advisor_handoff
      ) {
        return {
          ok: true,
          run_id: runId,
          state,
          action: "dispatch_plan_advisor",
          agent: "plan-advisor",
          skill: "orchestrating",
          command: null,
          instruction:
            "Task-dispatch plan-advisor once with the read-only Problem Brief. It may challenge decomposition but cannot write code or change state.",
          steps: [
            "Prepare Problem Brief: objective, constraints, risks, likely files, and verification boundary",
            "Task-dispatch agent: plan-advisor (planning-only, independent model)",
            "Synthesize the final plan in the orchestrator",
            "Pass plan_advisor evidence and planning_mode to PLANNED",
          ],
        };
      }
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
            "nexus run transition --to PLANNED --plan-check",
          ],
        };
      }
      if (hasPlan && runState.plan_check?.ok !== true) {
        return {
          ok: true,
          run_id: runId,
          state,
          action: "plan_check",
          agent: null,
          skill: "writing-plans",
          command: "nexus run transition --to PLANNED --plan-check --json '{\"planning_mode\":\"…\",\"plan_advisor\":{...}}'",
          instruction:
            "Run the integrated deterministic plan-check, fix hard errors and review warnings, then transition to PLANNED with its passing report.",
          steps: [
            "Resolve errors and add MERGED or KEEP_SEPARATE disposition for every actionable warning",
            "nexus run transition --to PLANNED --plan-check --json '{\"planning_mode\":\"…\",\"plan_advisor\":{...}}'",
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
        command: "nexus run transition --to PLANNED --plan-check",
        instruction: "PLAN.md exists. Run the integrated plan-check while transitioning to PLANNED.",
        steps: ["nexus run transition --to PLANNED --plan-check"],
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
          "Run fresh pre-impact for the next execution unit, then transition to TASK_IMPACT_READY.",
        steps: [
          "Load skill: impact-analysis",
          "nexus impact --json --targets <files for current execution unit>",
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
      switch (verificationStatus(runState, "TASK")) {
        case "PASSED":
          return {
            ok: true,
            run_id: runId,
            state,
            action: "transition_to_reviewing",
            agent: null,
            skill: "orchestrating",
            command: "nexus run transition --to REVIEWING",
            instruction:
              "Task verification passed. Authorize REVIEWING, then dispatch the independent reviewer.",
            steps: [
              "nexus run transition --to REVIEWING",
              "nexus review-package --scope task --json",
              "Task-dispatch agent: reviewer (review_scope=task)",
            ],
          };
        case "RUNNING":
        case "TIMED_OUT":
          return {
            ok: true,
            run_id: runId,
            state,
            action: "resume_verification",
            agent: null,
            skill: "orchestrating",
            command: "nexus verify --resume",
            instruction:
              "Verification is incomplete. Resume deterministic verification; do not redispatch the implementer or reviewer.",
            steps: ["nexus verify --resume", "After PASSED: nexus run transition --to REVIEWING"],
          };
        case "FAILED":
          return {
            ok: true,
            run_id: runId,
            state,
            action: "report_failed_verification",
            agent: null,
            skill: "orchestrating",
            command: "nexus run inspect",
            instruction:
              "Verification failed. Inspect the sealed evidence and repair the failure; do not dispatch a reviewer or silently re-enter IMPLEMENTING.",
            steps: ["nexus run inspect", "Fix the reported failure under normal workflow controls", "Run nexus verify again"],
          };
        default:
          return {
            ok: true,
            run_id: runId,
            state,
            action: "run_verification",
            agent: null,
            skill: "orchestrating",
            command: "nexus verify",
            instruction:
              "Run deterministic post-impact and verification. VERIFYING is not an LLM agent and does not dispatch the reviewer yet.",
            steps: ["nexus verify", "After PASSED: nexus run transition --to REVIEWING"],
          };
      }

    case "REVIEWING":
      if (stateHasSingleUnit(runState)) {
        return {
          ok: true,
          run_id: runId,
          state,
          action: "dispatch_reviewer",
          agent: "reviewer",
          skill: "orchestrating",
          command: "nexus review-package --scope task --json",
          instruction:
            "REQUIRED NOW: Generate the task review package and dispatch reviewer. For a single unit, reuse this evidence for final verification only if the reviewed commit equals current HEAD and the package digest is unchanged; otherwise use FINAL_REVIEWING.",
          steps: [
            "nexus review-package --scope task --json",
            "Task-dispatch agent: reviewer (review_scope=task)",
            "If APPROVED and digest/HEAD are unchanged: FINAL_VERIFYING with reuse_final_review=true",
            "Otherwise: FINAL_REVIEWING for a whole-branch reviewer call",
            "If REQUEST_CHANGES: fresh nexus impact → TASK_IMPACT_READY → implementer → reviewer",
          ],
        };
      }
      return {
        ok: true,
        run_id: runId,
        state,
        action: "dispatch_reviewer",
        agent: "reviewer",
        skill: "orchestrating",
        command: "nexus review-package --scope task --json",
        instruction:
          "REQUIRED NOW: Generate task review package, then Task-dispatch reviewer (scope=task). On REQUEST_CHANGES → fresh pre-impact → implementer again. On last-task APPROVED → FINAL_REVIEWING (not FINAL_VERIFYING).",
        steps: [
          "nexus review-package --scope task --json",
          "Task-dispatch agent: reviewer (review_scope=task; read the review package)",
          "If APPROVED and more tasks: TASK_IMPACT_READY with next_task + fresh impact",
          "If APPROVED and done: nexus run transition --to FINAL_REVIEWING --json '{\"review_handoff\":{...},\"review_package\":{...}}'",
          "If REQUEST_CHANGES: fresh nexus impact → TASK_IMPACT_READY → implementer → reviewer",
        ],
      };

    case "FINAL_REVIEWING":
      return {
        ok: true,
        run_id: runId,
        state,
        action: "dispatch_reviewer",
        agent: "reviewer",
        skill: "orchestrating",
        command: "nexus review-package --scope final --json",
        instruction:
          "REQUIRED NOW: Generate final (whole-branch) review package, then Task-dispatch reviewer with review_scope=final. Cross-task integration defects are in scope.",
        steps: [
          "nexus review-package --scope final --json",
          "Task-dispatch agent: reviewer (review_scope=final; whole-branch package)",
          "If APPROVED: nexus run transition --to FINAL_VERIFYING --json '{\"review_handoff\":{...},\"review_package\":{...}}'",
          "If REQUEST_CHANGES: fresh nexus impact → TASK_IMPACT_READY → implementer → … → final review again",
        ],
      };

    case "FINAL_VERIFYING":
      switch (verificationStatus(runState, "FINAL")) {
        case "PASSED":
          return {
            ok: true,
            run_id: runId,
            state,
            action: "transition_to_completed",
            agent: null,
            skill: "finishing-a-development-branch",
            command: "nexus run transition --to COMPLETED",
            instruction:
              "Final deterministic verification passed. Authorize COMPLETED, then finish the branch.",
            steps: ["nexus run transition --to COMPLETED", "Load skill: finishing-a-development-branch"],
          };
        case "RUNNING":
        case "TIMED_OUT":
          return {
            ok: true,
            run_id: runId,
            state,
            action: "resume_verification",
            agent: null,
            skill: "orchestrating",
            command: "nexus verify --resume",
            instruction:
              "Final verification is incomplete. Resume it; do not mark the run completed.",
            steps: ["nexus verify --resume", "After PASSED: nexus run transition --to COMPLETED"],
          };
        case "FAILED":
          return {
            ok: true,
            run_id: runId,
            state,
            action: "report_failed_verification",
            agent: null,
            skill: "orchestrating",
            command: "nexus run inspect",
            instruction:
              "Final verification failed. Inspect the sealed evidence; COMPLETED remains forbidden.",
            steps: ["nexus run inspect", "Repair through the normal workflow", "Run nexus verify again"],
          };
        default:
          return {
            ok: true,
            run_id: runId,
            state,
            action: "run_verification",
            agent: null,
            skill: "orchestrating",
            command: "nexus verify",
            instruction:
              "Run deterministic final verification before attempting COMPLETED.",
            steps: ["nexus verify", "After PASSED: nexus run transition --to COMPLETED"],
          };
      }

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
