/**
 * Deterministic next-action resolver for Nexus V5.
 * Given durable run state (+ optional worktree probes), tell the orchestrator
 * exactly what to do next — including which agent to Task-dispatch.
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import {
  normalizePlanAdvisorDecision,
  planAdvisorDecision,
  planningModeFromEvidence,
} from "./planning.js";
import { getAgentCallBudget } from "./providers.js";
import { validateContainedPath } from "./filesystem-boundary.js";
import { verifySealedArtifact } from "./artifact-seal.js";
import {
  DEFAULT_MAX_FIX_LOOP_ATTEMPTS,
  DEFAULT_MAX_VERIFICATION_REPAIR_ATTEMPTS,
} from "./review-protocol.js";

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
 * @property {{mode: "AUTO"|"AWAIT_AGENT"|"AWAIT_USER"|"MANUAL"|"FINISH", resume_on: string|null}} continuation
 */

function planExists(worktree) {
  if (!worktree) return false;
  const planPath = path.resolve(worktree, ".opencode", "plans", "PLAN.md");
  const boundary = validateContainedPath(worktree, planPath, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  return boundary.ok && boundary.exists && fs.existsSync(planPath);
}

function stateHasSingleUnit(runState) {
  const candidates = [
    runState?.execution_units,
    runState?.units,
    runState?.tasks,
    runState?.task_count,
    runState?.plan_check?.execution_units,
    runState?.plan_check?.tasks,
    runState?.plan_check?.unit_count,
  ].filter((candidate) => candidate != null);
  const counts = candidates
    .map((candidate) => {
      if (Array.isArray(candidate)) return candidate.length;
      const count = Number(candidate);
      return Number.isInteger(count) && count >= 0 ? count : null;
    })
    .filter((count) => count != null && count > 0);
  return counts.length > 0 && Math.max(...counts) === 1;
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

/**
 * Whether this run still owes an independent planning challenge.
 * Uses the persisted decision when one exists; otherwise re-derives it from the
 * same evidence, so routing never depends on an agent's judgement.
 *
 * A run with no planning evidence at all keeps the workflow's long-standing
 * compact default: there is nothing to escalate on yet, and the PLANNED gate
 * re-decides once classification or a plan exists.
 */
function runAdvisorRequired(runState) {
  const persisted = normalizePlanAdvisorDecision(runState?.plan_advisor_decision);
  if (persisted) return persisted.required;
  const mode = stateRunPlanningMode(runState);
  if (!mode) return false;
  const classification = runState?.classification || {};
  return planAdvisorDecision({
    ...classification,
    ...runState,
    planning_mode: mode,
    change_class:
      runState?.change_class || classification.change_class || classification.changeClass,
    files_changed:
      runState?.files_changed || classification.files_changed || classification.filesChanged,
    estimated_lines:
      runState?.estimated_lines ||
      classification.estimated_lines ||
      classification.estimatedLines,
  }).required;
}

function exhaustedAgentCallBudget(runState) {
  const used = Number(runState?.agent_calls_used);
  const storedBudget = runState?.agent_call_budget;
  let max = Number(storedBudget?.max_calls);
  const unitCount = [
    runState?.execution_units,
    runState?.units,
    runState?.tasks,
    runState?.task_count,
    runState?.plan_check?.execution_units,
    runState?.plan_check?.tasks,
    runState?.plan_check?.unit_count,
  ]
    .filter((candidate) => candidate != null)
    .map((candidate) => {
      if (Array.isArray(candidate)) return candidate.length;
      const count = Number(candidate);
      return Number.isInteger(count) && count >= 0 ? count : null;
    })
    .filter((count) => count != null && count > 0)
    .reduce((largest, count) => Math.max(largest, count), 0);
  const storedIsStaleDerived =
    unitCount > 0 &&
    storedBudget?.source === "v5-default-workflow" &&
    Number(storedBudget.units) !== unitCount &&
    Number(storedBudget.max_calls) === Number(storedBudget.derived_max_calls);
  if (storedIsStaleDerived) {
    max = getAgentCallBudget({
      units: unitCount,
      planningAdvisorCalls: runState.plan_advisor_calls,
    }).max_calls;
  }
  return Number.isFinite(used) && Number.isFinite(max) && max >= 0 && used >= max
    ? { used, max }
    : null;
}

function agentBudgetBlock(runId, state, budget) {
  const reason = `agent-call budget is exhausted (${budget.used}/${budget.max}) before implementer dispatch`;
  return {
    ok: true,
    run_id: runId,
    state,
    action: "block_for_agent_budget",
    agent: null,
    skill: "reconcile",
    command:
      `nexus run transition --to BLOCKED --run-id ${runId || "<id>"} ` +
      `--json '{"block_code":"AGENT_CALL_BUDGET_EXCEEDED","block_reason":"${reason}"}'`,
    instruction:
      `${reason}. Do not Task-dispatch an implementer; record the block and reconcile the plan or run budget.`,
    steps: [
      "Do not Task-dispatch implementer",
      "Transition to BLOCKED with AGENT_CALL_BUDGET_EXCEEDED",
      "Load reconcile and reduce/replan the remaining work before resuming",
    ],
  };
}

function exhaustedFixLoop(runState) {
  if (runState?.state !== "REVIEWING" && runState?.state !== "FINAL_REVIEWING") {
    return null;
  }
  const handoff = runState?.last_review_handoff;
  if (handoff?.verdict !== "REQUEST_CHANGES") return null;
  const unit = String(
    runState?.pending_review_unit ||
      runState?.current_unit ||
      handoff.unit_or_task ||
      handoff.task_id ||
      "",
  ).trim();
  const attempts = Number(runState?.fix_loop_attempts?.[unit]);
  if (!unit || !Number.isInteger(attempts) || attempts < DEFAULT_MAX_FIX_LOOP_ATTEMPTS) {
    return null;
  }
  return { unit, attempts };
}

function fixLoopBlock(runId, state, loop) {
  return {
    ok: true,
    run_id: runId,
    state,
    action: "block_for_fix_loop",
    agent: null,
    skill: "reconcile",
    command:
      `nexus run transition --to BLOCKED --run-id ${runId || "<id>"} ` +
      `--json '{"block_code":"FIX_LOOP_EXHAUSTED","block_reason":"maximum reviewer remediation attempts reached"}'`,
    instruction:
      `Fix-loop budget is exhausted for ${loop.unit} (${loop.attempts}/${DEFAULT_MAX_FIX_LOOP_ATTEMPTS}). Do not dispatch another reviewer or implementer; transition to BLOCKED and reconcile.`,
    steps: [
      "Do not dispatch another reviewer or implementer",
      "Transition to BLOCKED with FIX_LOOP_EXHAUSTED",
      "Load reconcile and repair the remaining finding or replan the unit",
    ],
  };
}

function verificationStatus(runState, phase) {
  const record = runState?.verification;
  if (record && typeof record === "object" && !record.phase) {
    return record.status || runState?.verification_status || "PENDING";
  }
  if (record && typeof record === "object" && record.phase !== phase) return "PENDING";
  if (record && typeof record === "object") {
    return record.status || runState?.verification_status || "PENDING";
  }
  return runState?.verification_status || "PENDING";
}

function currentHead(worktree, suppliedHead = null) {
  if (typeof suppliedHead === "string" && suppliedHead.trim()) {
    return suppliedHead.trim();
  }
  if (!worktree) return null;
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree,
      encoding: "utf8",
    });
    if (result.status !== 0) return null;
    return String(result.stdout || "").trim() || null;
  } catch {
    return null;
  }
}

function currentBranch(worktree) {
  if (!worktree) return null;
  try {
    const result = spawnSync("git", ["branch", "--show-current"], {
      cwd: worktree,
      encoding: "utf8",
    });
    if (result.status !== 0) return null;
    return String(result.stdout || "").trim() || null;
  } catch {
    return null;
  }
}

function dispatchBinding(runState) {
  const state = runState?.state;
  if (!["IMPLEMENTING", "REVIEWING", "FINAL_REVIEWING"].includes(state)) {
    return { head: null, branch: null };
  }

  let head = null;
  if (state === "IMPLEMENTING") {
    head = runState.head_commit || null;
  } else if (state === "REVIEWING") {
    head =
      runState.implementer_commit ||
      runState.last_implementer_handoff?.commit ||
      runState.verification?.worktree_head ||
      null;
  } else if (state === "FINAL_REVIEWING") {
    head =
      runState.implementer_commit ||
      runState.last_task_review_handoff?.reviewed_commit ||
      runState.last_review_handoff?.reviewed_commit ||
      null;
  }
  return {
    head,
    branch: typeof runState.branch === "string" && runState.branch.trim()
      ? runState.branch.trim()
      : null,
  };
}

function dispatchBindingMismatch(runState, worktree) {
  const binding = dispatchBinding(runState);
  if (!worktree || (!binding.head && !binding.branch)) return null;

  const actualHead = binding.head ? currentHead(worktree) : null;
  const actualBranch = binding.branch ? currentBranch(worktree) : null;
  const reasons = [];
  if (binding.head && !actualHead) {
    reasons.push(`worktree HEAD is unavailable (expected ${binding.head})`);
  } else if (binding.head && actualHead !== binding.head) {
    reasons.push(`worktree HEAD ${actualHead} does not match expected ${binding.head}`);
  }
  if (binding.branch && !actualBranch) {
    reasons.push(`worktree branch is unavailable (expected ${binding.branch})`);
  } else if (binding.branch && actualBranch !== binding.branch) {
    reasons.push(`worktree branch ${actualBranch} does not match expected ${binding.branch}`);
  }
  return reasons.length > 0
    ? { ...binding, actualHead, actualBranch, reasons }
    : null;
}

function worktreeReconcileAction(runId, state, mismatch) {
  return {
    ok: true,
    run_id: runId,
    state,
    action: "reconcile",
    agent: null,
    skill: "reconcile",
    command: `nexus run inspect${runId ? ` --run-id ${runId}` : ""}`,
    instruction:
      `Do not dispatch an agent: the persisted run binding does not match the current worktree (${mismatch.reasons.join("; ")}). Reconcile the run/worktree binding and obtain fresh evidence before continuing.`,
    steps: [
      "Do not Task-dispatch an implementer or reviewer",
      `Inspect the run binding with nexus run inspect${runId ? ` --run-id ${runId}` : ""}`,
      "Confirm the intended worktree HEAD and branch, then refresh the persisted state or use the correct worktree",
      "Run nexus next again only after the binding is reconciled",
    ],
  };
}

function hasExecutedFailedCheck(artifact) {
  return Array.isArray(artifact?.results) && artifact.results.some((result) =>
    result &&
    result.status !== "UNAVAILABLE" &&
    result.status !== "SKIPPED" &&
    result.timed_out !== true &&
    result.error_code == null &&
    result.signal == null &&
    result.pass === false &&
    result.exit_code != null,
  );
}

/**
 * The resolver is deliberately conservative: the state machine is the final
 * authority, but `nexus next` must not advertise an automatic repair for a
 * timeout, unavailable provider, stale HEAD, dirty/unmeasurable worktree, or
 * an unexecuted check.
 */
function verificationRepairCandidate(runState, phase, worktree, suppliedHead = null) {
  const summary = runState?.verification;
  const artifactField = phase === "FINAL" ? "final_verification" : "provider_verification";
  const artifact = runState?.[artifactField];
  const head = currentHead(worktree, suppliedHead);
  const attempts = Math.max(
    0,
    Math.floor(Number(runState?.verification_repair_attempts) || 0),
  );

  if (
    runState?.verification_status !== "FAILED" ||
    summary?.status !== "FAILED" ||
    summary?.phase !== phase ||
    summary?.failure_reason !== "VERIFICATION_FAILED" ||
    !verifySealedArtifact(artifact) ||
    artifact.ok !== false ||
    artifact.timed_out === true ||
    artifact.workspace_integrity_available !== true ||
    artifact.workspace_clean !== true ||
    !hasExecutedFailedCheck(artifact) ||
    !head ||
    summary.worktree_head !== head ||
    artifact.worktree_head !== head ||
    !summary.artifact_digest ||
    summary.artifact_digest !== artifact.artifact_digest
  ) {
    return null;
  }

  return {
    phase,
    artifact_digest: artifact.artifact_digest,
    attempts,
  };
}

function verificationRepairBlock(runId, state, candidate) {
  const phaseLabel = candidate?.phase || "verification";
  return {
    ok: true,
    run_id: runId,
    state,
    action: "block_for_verification_repair",
    agent: null,
    skill: "reconcile",
    command:
      `nexus run transition --to BLOCKED --run-id ${runId || "<id>"} ` +
      `--json '{"block_code":"VERIFICATION_REPAIR_EXHAUSTED","block_reason":"automatic ${phaseLabel.toLowerCase()} verification repair budget exhausted"}'`,
    instruction:
      `The bounded automatic ${phaseLabel.toLowerCase()} verification repair was already used (${candidate.attempts}/${DEFAULT_MAX_VERIFICATION_REPAIR_ATTEMPTS}). Transition to BLOCKED and reconcile; do not dispatch another automatic repair pass.`,
    steps: [
      "Do not dispatch another implementer or reviewer from the failed verification state",
      "Transition to BLOCKED with VERIFICATION_REPAIR_EXHAUSTED",
      "Load reconcile and inspect the failed sealed artifact before choosing a manual repair",
    ],
  };
}

function verificationRepairAction(runId, state, candidate) {
  const phaseLabel = candidate.phase;
  return {
    ok: true,
    run_id: runId,
    state,
    action: "repair_verification",
    agent: null,
    skill: "impact-analysis",
    command:
      `nexus impact --json --targets <current unit files> && ` +
      `nexus run transition --to TASK_IMPACT_READY --run-id ${runId || "<id>"} ` +
      `--json '{"verification_repair":{"phase":"${phaseLabel}","artifact_digest":"${candidate.artifact_digest}"},"impact":<fresh-impact-report>}'`,
    instruction:
      `Verification failed on an executed check, but the sealed evidence is current and the workspace is clean. Run one fresh impact analysis, then transition directly to TASK_IMPACT_READY for the bounded automatic repair; do not ask the user or dispatch a verifier subagent.`,
    steps: [
      "Load skill: impact-analysis",
      "Run fresh nexus impact for the current execution-unit scope",
      `Transition ${state} → TASK_IMPACT_READY with verification_repair.phase=${phaseLabel} and the exact persisted artifact digest`,
      "Re-run nexus next and dispatch the implementer only after TASK_IMPACT_READY",
    ],
  };
}

function continuationFor(next) {
  if (next.state === "COMPLETED") {
    return { mode: "FINISH", resume_on: null };
  }
  if (next.state === "WAITING_FOR_USER") {
    return { mode: "AWAIT_USER", resume_on: "user_answer" };
  }
  if (next.state === "FAILED") {
    return { mode: "MANUAL", resume_on: null };
  }
  if (
    next.state === "BLOCKED" ||
    next.action === "reconcile" ||
    next.action === "block_for_agent_budget" ||
    next.action === "block_for_fix_loop" ||
    next.action === "block_for_verification_repair"
  ) {
    return { mode: "MANUAL", resume_on: "repair" };
  }
  if (next.action === "report_failed_verification") {
    return { mode: "MANUAL", resume_on: "repair" };
  }
  if (next.action === "unknown_state") {
    return { mode: "MANUAL", resume_on: null };
  }
  if (next.agent === "plan-advisor") {
    return { mode: "AWAIT_AGENT", resume_on: "plan_advisor_handoff" };
  }
  if (next.agent === "implementer") {
    return { mode: "AWAIT_AGENT", resume_on: "implementer_handoff" };
  }
  if (next.agent === "reviewer") {
    return { mode: "AWAIT_AGENT", resume_on: "reviewer_handoff" };
  }
  return { mode: "AUTO", resume_on: null };
}

/**
 * @param {object|null|undefined} runState - run state.json or { state, run_id }
 * @param {{ worktree?: string|null }} [opts]
 * @returns {NextAction}
 */
function resolveNextActionInternal(runState, opts = {}) {
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

  const bindingMismatch = dispatchBindingMismatch(runState, worktree);
  if (bindingMismatch) {
    return worktreeReconcileAction(runId, state, bindingMismatch);
  }

  const budget = exhaustedAgentCallBudget(runState);
  if (budget && (state === "TASK_IMPACT_READY" || state === "IMPLEMENTING")) {
    return agentBudgetBlock(runId, state, budget);
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
        runAdvisorRequired(runState) &&
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
            "nexus project-profile --json (advisory cached repo recon; still read the task-specific code)",
            "Else: Load skill: writing-plans → create .opencode/plans/PLAN.md",
            "Do not write .opencode/tasks/task-N.md; PLANNED generates those views",
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
          {
            const candidate = verificationRepairCandidate(
              runState,
              "TASK",
              worktree,
              opts.current_head || opts.currentHead,
            );
            if (candidate && candidate.attempts < DEFAULT_MAX_VERIFICATION_REPAIR_ATTEMPTS) {
              return verificationRepairAction(runId, state, candidate);
            }
            if (candidate) return verificationRepairBlock(runId, state, candidate);
          }
          return {
            ok: true,
            run_id: runId,
            state,
            action: "report_failed_verification",
            agent: null,
            skill: "orchestrating",
            command: "nexus run inspect",
            instruction:
              "Verification failed without eligible current sealed evidence for the bounded automatic repair. Inspect the artifact and handle the failure manually; do not dispatch a reviewer or silently re-enter IMPLEMENTING.",
            steps: ["nexus run inspect", "Reconcile the reported failure and obtain any required approval", "Run nexus verify again"],
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

    case "REVIEWING": {
      const loop = exhaustedFixLoop(runState);
      if (loop) return fixLoopBlock(runId, state, loop);
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
    }

    case "FINAL_REVIEWING": {
      const loop = exhaustedFixLoop(runState);
      if (loop) return fixLoopBlock(runId, state, loop);
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
    }

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
          {
            const candidate = verificationRepairCandidate(
              runState,
              "FINAL",
              worktree,
              opts.current_head || opts.currentHead,
            );
            if (candidate && candidate.attempts < DEFAULT_MAX_VERIFICATION_REPAIR_ATTEMPTS) {
              return verificationRepairAction(runId, state, candidate);
            }
            if (candidate) return verificationRepairBlock(runId, state, candidate);
          }
          return {
            ok: true,
            run_id: runId,
            state,
            action: "report_failed_verification",
            agent: null,
            skill: "orchestrating",
            command: "nexus run inspect",
            instruction:
              "Final verification failed without eligible current sealed evidence for the bounded automatic repair. Inspect the artifact; COMPLETED remains forbidden.",
            steps: ["nexus run inspect", "Reconcile the reported failure and obtain any required approval", "Run nexus verify again"],
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
 * Resolve the next action and attach the restart-safe continuation contract.
 * Keeping this at the single public exit point ensures every action branch is
 * classified, including future branches added to the internal resolver.
 */
export function resolveNextAction(runState, opts = {}) {
  const next = resolveNextActionInternal(runState, opts);
  return { ...next, continuation: continuationFor(next) };
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
    `- continuation: ${next.continuation?.mode || "AUTO"} (resume_on=${next.continuation?.resume_on || "null"})`,
    `- user_input: ${next.continuation?.mode === "AWAIT_USER" ? "required (planning clarification)" : "none (continue; critical approval only)"}`,
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
