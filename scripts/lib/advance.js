/**
 * PR7: `nexus advance` — execute the deterministic chain of the orchestrator
 * loop up to the next agent/user boundary, then hand back a prepared dispatch.
 *
 * Authority model (deliberately unchanged):
 * - Every state change is performed by the existing gate CLI
 *   (`nexus run transition`), never by this module.
 * - Every measurement is produced by the existing provider command
 *   (`nexus impact`, `nexus verify`, `nexus review-package`).
 * - Advance owns *ordering* only. It never writes a handoff, never invents or
 *   edits evidence, never dispatches an agent, never retries a rejected gate
 *   with different evidence, and stops on the first rejection.
 * - Evidence produced by an agent is consumed only from its canonical handoff
 *   path, only when it is fresh for the current state, and only through the
 *   normal `--implementer-handoff-file` / `--review-handoff-file` flags, so the
 *   state machine still performs every admissibility and binding check.
 *
 * The planner in this file is pure: it maps (resolved next action + probed
 * facts) to either one executable deterministic step or an explicit stop. The
 * executor is a thin, auditable shim that runs the steps the planner names.
 */

import path from "path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "url";
import { resolveNextAction } from "./next-action.js";
import { latestActiveRunState, readRunState } from "./migrate-artifacts.js";
import {
  consumableImplementerHandoff,
  consumableReviewerHandoff,
  enteredStateAt,
} from "./handoff-freshness.js";

export { enteredStateAt };

export const ADVANCE_VERSION = "nexus-advance/1";

/** Hard ceiling on deterministic steps per call: advance is bounded, not a daemon. */
export const ADVANCE_MAX_STEPS = 12;

/** Branches advance refuses to treat as an execution branch. */
export const PROTECTED_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

/**
 * Why advance stopped. `SELF` is orchestrator work (brainstorm, write the plan),
 * `AGENT` needs a Task dispatch, `USER` needs a human answer, `MANUAL` needs a
 * documented repair, `DONE` is terminal.
 */
export const BOUNDARIES = ["SELF", "AGENT", "USER", "MANUAL", "DONE"];

/**
 * Deterministic steps advance is allowed to execute. Anything not in this table
 * stops the chain: the allowlist is the security boundary, so a new resolver
 * action is inert until it is deliberately added here.
 */
export const EXECUTABLE_STEPS = [
  "start_brainstorming",
  "plan_check_transition",
  "pre_impact",
  "authorize_implementing",
  "consume_implementer_handoff",
  "verify",
  "verify_resume",
  "authorize_reviewing",
  "build_review_package",
  "consume_review_handoff",
  "authorize_completed",
];

const nexusBin = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "nexus.js",
);

function git(worktree, args) {
  const result = spawnSync("git", args, {
    cwd: worktree,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return String(result.stdout || "").trim();
}

/** Units recorded by the PLANNED gate — never re-parsed prose. */
export function stateUnits(state) {
  const units = state?.execution_units || state?.units || state?.tasks;
  return Array.isArray(units) ? units.filter((unit) => unit && unit.id) : [];
}

export function unitById(state, id) {
  return stateUnits(state).find((unit) => unit.id === id) || null;
}

/** Units already approved in this run (task-scope APPROVED history). */
export function approvedUnitIds(state) {
  const history = Array.isArray(state?.task_history) ? state.task_history : [];
  return new Set(
    history
      .filter((entry) => entry?.verdict === "APPROVED" || entry?.status === "APPROVED")
      .map((entry) => entry?.id || entry?.unit_or_task)
      .filter(Boolean),
  );
}

/** The unit under execution: the recorded one, else the first unapproved unit. */
export function currentUnit(state) {
  const units = stateUnits(state);
  if (units.length === 0) return null;
  if (state?.current_unit) {
    const recorded = unitById(state, state.current_unit);
    if (recorded) return recorded;
  }
  const approved = approvedUnitIds(state);
  return units.find((unit) => !approved.has(unit.id)) || null;
}

/** The next unit whose dependencies are already approved. */
export function nextUnit(state) {
  const units = stateUnits(state);
  const approved = approvedUnitIds(state);
  const current = currentUnit(state);
  const done = new Set(approved);
  if (current) done.add(current.id);
  return (
    units.find(
      (unit) =>
        !done.has(unit.id) &&
        (Array.isArray(unit.depends_on) ? unit.depends_on : []).every((dep) =>
          done.has(dep),
        ),
    ) || null
  );
}

function unitTargets(unit) {
  const files = Array.isArray(unit?.allowed_files) ? unit.allowed_files : [];
  return files.filter((file) => typeof file === "string" && file.trim());
}

function unitAcceptance(unit) {
  const criteria = Array.isArray(unit?.acceptance_criteria)
    ? unit.acceptance_criteria
    : [];
  return criteria.filter((item) => typeof item === "string" && item.trim());
}

/** Read-only probe of everything the planner is allowed to reason about. */
export function collectFacts(worktree, state) {
  const runId = state?.run_id || null;
  const head = git(worktree, ["rev-parse", "HEAD"]);
  const branch = git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = git(worktree, ["status", "--porcelain"]);
  const dirtyCode = String(dirty || "")
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter((file) => file && !file.startsWith(".opencode/"));

  const unit = currentUnit(state);
  return {
    worktree,
    state,
    head_commit: head || null,
    branch: branch && branch !== "HEAD" ? branch : null,
    dirty_code: dirtyCode,
    unit,
    unit_targets: unitTargets(unit),
    unit_acceptance: unitAcceptance(unit),
    next_unit: nextUnit(state),
    unit_count: stateUnits(state).length,
    implementer_handoff: runId
      ? consumableImplementerHandoff(worktree, state, head || null)
      : null,
    reviewer_handoff: runId
      ? consumableReviewerHandoff(
          worktree,
          state,
          head || null,
          state?.state === "FINAL_REVIEWING" ? "final" : "task",
        )
      : null,
    review_package: state?.review_package || null,
  };
}

function stop(boundary, code, instruction, extra = {}) {
  return { stop: { boundary, reason_code: code, instruction, ...extra } };
}

function execute(step, detail = {}) {
  return { execute: { step, ...detail } };
}

/** Prepared dispatch descriptor: evidence the orchestrator passes to the agent. */
export function preparedDispatch(agent, facts, next) {
  const state = facts.state || {};
  if (agent === "implementer") {
    return {
      agent: "implementer",
      skill: "orchestrating",
      prompt: "skills/orchestrating/implementer-prompt.md",
      run_id: state.run_id || null,
      unit_or_task: facts.unit?.id || state.current_unit || null,
      branch: state.branch || facts.branch,
      base_commit: state.run_base_commit || state.head_commit || null,
      user_outcome: facts.unit?.user_outcome || null,
      acceptance_criteria: facts.unit_acceptance.length
        ? facts.unit_acceptance
        : state.acceptance_criteria || [],
      allowed_files: facts.unit_targets.length
        ? facts.unit_targets
        : state.allowed_files || [],
      stop_conditions: facts.unit?.stop_conditions || [],
      impact: state.impact
        ? {
            risk: state.impact.risk || state.impact.level || null,
            direct_dependents: state.impact.direct_dependents || null,
            related_tests: state.impact.related_tests || null,
          }
        : null,
      handoff_path: facts.implementer_handoff?.path || null,
    };
  }
  if (agent === "reviewer") {
    const scope = state.state === "FINAL_REVIEWING" ? "final" : "task";
    return {
      agent: "reviewer",
      skill: "orchestrating",
      prompt: "skills/orchestrating/reviewer-prompt.md",
      run_id: state.run_id || null,
      unit_or_task: facts.unit?.id || state.current_unit || null,
      review_scope: scope,
      review_package_path: facts.review_package?.path || null,
      review_package_digest: facts.review_package?.digest_sha256 || null,
      reviewed_commit: facts.head_commit,
      acceptance_criteria: facts.review_package?.acceptance_criteria || [],
      sealed_commands: (facts.review_package?.sealed_commands || []).map(
        (entry) => entry.command,
      ),
      handoff_path: facts.reviewer_handoff?.path || null,
    };
  }
  return {
    agent,
    skill: next?.skill || null,
    run_id: state.run_id || null,
    unit_or_task: facts.unit?.id || state.current_unit || null,
  };
}

/**
 * Pure planner: one resolved action in, one executable step or one stop out.
 *
 * @param {object} next  resolveNextAction() result
 * @param {object} facts collectFacts() result
 */
export function planAdvanceStep(next, facts) {
  const state = facts.state || {};
  const action = next?.action || null;

  if (next?.ok === false || action === "unknown_state") {
    return stop("MANUAL", "UNRESOLVABLE_STATE", next?.instruction || "Inspect the run.");
  }

  switch (action) {
    // ---- orchestrator's own work: advance prepares state, never the thinking
    case "init_run":
      return stop(
        "SELF",
        "NO_RUN",
        "Initialize the run yourself: the run id names the work. nexus run init --run-id <id>",
      );

    case "brainstorm":
      if (state.state === "CREATED") {
        return execute("start_brainstorming", { to: "BRAINSTORMING" });
      }
      return stop("SELF", "BRAINSTORM_REQUIRED", next.instruction);

    case "write_plan":
      return stop("SELF", "PLAN_REQUIRED", next.instruction);

    case "await_user":
      return stop("USER", "AWAITING_USER_ANSWER", next.instruction);

    // ---- deterministic gates
    case "plan_check":
    case "transition":
      if (state.state === "BRAINSTORMING") {
        return execute("plan_check_transition", { to: "PLANNED" });
      }
      return stop("MANUAL", "UNSUPPORTED_TRANSITION", next.instruction);

    case "pre_impact": {
      if (facts.unit && !SAFE_UNIT_ID_RE.test(String(facts.unit.id))) {
        return stop(
          "MANUAL",
          "UNSAFE_UNIT_ID",
          `Execution unit id ${JSON.stringify(facts.unit.id)} is not a safe identifier; fix the plan.`,
        );
      }
      if (!facts.unit) {
        return stop(
          "MANUAL",
          "NO_EXECUTION_UNIT",
          "No execution unit is available on run state; re-run the PLANNED gate.",
        );
      }
      if (facts.unit_targets.length === 0) {
        return stop(
          "MANUAL",
          "UNIT_WITHOUT_SCOPE",
          `Execution unit ${facts.unit.id} records no in-scope files; fix the plan scope.`,
        );
      }
      return execute("pre_impact", {
        unit: facts.unit.id,
        targets: facts.unit_targets,
        to: "TASK_IMPACT_READY",
      });
    }

    case "transition_then_dispatch": {
      if (!facts.unit) {
        return stop("MANUAL", "NO_EXECUTION_UNIT", "No execution unit on run state.");
      }
      const branch = state.branch || facts.branch;
      if (!branch || PROTECTED_BRANCHES.has(branch)) {
        return stop(
          "SELF",
          "NO_EXECUTION_BRANCH",
          `Create and check out the execution branch first (current: ${branch || "unknown"}). Branch naming belongs to using-feature-branches, not to advance.`,
        );
      }
      if (facts.unit_acceptance.length === 0) {
        return stop(
          "MANUAL",
          "UNIT_WITHOUT_ACCEPTANCE",
          `Execution unit ${facts.unit.id} records no acceptance criteria; fix the plan.`,
        );
      }
      return execute("authorize_implementing", {
        to: "IMPLEMENTING",
        unit: facts.unit.id,
        branch,
        acceptance: facts.unit_acceptance,
        allowed_files: facts.unit_targets,
      });
    }

    case "consume_implementer_handoff": {
      const handoff = facts.implementer_handoff;
      if (!handoff?.consumable) {
        return stop("AGENT", "IMPLEMENTER_DISPATCH_REQUIRED", next.instruction, {
          dispatch: preparedDispatch("implementer", facts, next),
          handoff_state: handoff?.reason || "ABSENT",
        });
      }
      return execute("consume_implementer_handoff", {
        to: "VERIFYING",
        handoff_path: handoff.path,
      });
    }

    case "dispatch_implementer":
      return stop("AGENT", "IMPLEMENTER_DISPATCH_REQUIRED", next.instruction, {
        dispatch: preparedDispatch("implementer", facts, next),
        handoff_state: facts.implementer_handoff?.data
          ? facts.implementer_handoff.reason
          : "ABSENT",
      });

    case "run_verification":
      return execute("verify", {});

    case "resume_verification":
      return execute("verify_resume", {});

    case "transition_to_reviewing":
      return execute("authorize_reviewing", { to: "REVIEWING" });

    case "dispatch_reviewer": {
      const scope = state.state === "FINAL_REVIEWING" ? "final" : "task";
      const pkg = facts.review_package;
      const packageCurrent =
        pkg &&
        pkg.scope === scope &&
        pkg.head_commit === facts.head_commit &&
        (scope !== "task" || !facts.unit || pkg.unit_or_task === facts.unit.id);
      if (!packageCurrent) {
        return execute("build_review_package", { scope });
      }
      const handoff = facts.reviewer_handoff;
      if (handoff?.consumable) {
        const route = reviewRoute(handoff.data, facts);
        if (route.stop) return route;
        return execute("consume_review_handoff", {
          ...route.execute,
          handoff_path: handoff.path,
          scope,
        });
      }
      return stop("AGENT", "REVIEWER_DISPATCH_REQUIRED", next.instruction, {
        dispatch: preparedDispatch("reviewer", facts, next),
        handoff_state: handoff?.data ? handoff.reason : "ABSENT",
      });
    }

    case "transition_to_completed":
      return execute("authorize_completed", { to: "COMPLETED" });

    // ---- explicitly not automated: documented repairs stay deliberate
    case "dispatch_plan_advisor":
      return stop("AGENT", "PLAN_ADVISOR_DISPATCH_REQUIRED", next.instruction, {
        dispatch: preparedDispatch("plan-advisor", facts, next),
      });

    case "repair_verification":
      return stop("MANUAL", "VERIFICATION_REPAIR_AVAILABLE", next.instruction);
    case "report_failed_verification":
      return stop("MANUAL", "VERIFICATION_FAILED", next.instruction);
    case "reconcile":
      return stop("MANUAL", "RECONCILE_REQUIRED", next.instruction);
    case "block_for_agent_budget":
      return stop("MANUAL", "AGENT_BUDGET_EXHAUSTED", next.instruction);
    case "block_for_fix_loop":
      return stop("MANUAL", "FIX_LOOP_EXHAUSTED", next.instruction);
    case "block_for_verification_repair":
      return stop("MANUAL", "VERIFICATION_REPAIR_EXHAUSTED", next.instruction);

    case "done":
      return stop("DONE", state.state === "COMPLETED" ? "COMPLETED" : "TERMINAL", next.instruction);

    default:
      return stop("MANUAL", "UNSUPPORTED_ACTION", next?.instruction || `No deterministic step for ${action}.`);
  }
}

/**
 * Deterministic route for a fresh reviewer verdict. The verdict decides the
 * target state; the state machine still decides whether the transition is
 * allowed. Single-unit final-review reuse is only *requested* when the state
 * machine's own read-only check admits it, and the mandatory full final review
 * is the fallback — never the other way around.
 */
export function reviewRoute(handoff, facts) {
  const state = facts.state || {};
  const verdict = handoff?.verdict || null;
  const scope = state.state === "FINAL_REVIEWING" ? "final" : "task";

  if (verdict === "REQUEST_CHANGES") {
    const unit = facts.unit;
    if (!unit) {
      return stop("MANUAL", "NO_EXECUTION_UNIT", "REQUEST_CHANGES needs the unit to re-scope.");
    }
    return execute("consume_review_handoff", {
      to: "TASK_IMPACT_READY",
      reason: "REQUEST_CHANGES",
      unit: unit.id,
      targets: unitTargets(unit),
      fresh_impact: true,
    });
  }

  if (verdict !== "APPROVED") {
    return stop(
      "MANUAL",
      "NON_ADVANCING_VERDICT",
      `Reviewer verdict ${verdict || "missing"} does not advance the run; resolve it explicitly.`,
    );
  }

  if (scope === "final") {
    return execute("consume_review_handoff", { to: "FINAL_VERIFYING", reason: "FINAL_APPROVED" });
  }

  const upcoming = facts.next_unit;
  if (upcoming) {
    return execute("consume_review_handoff", {
      to: "TASK_IMPACT_READY",
      reason: "NEXT_UNIT",
      unit: upcoming.id,
      targets: unitTargets(upcoming),
      next_task: true,
      fresh_impact: true,
    });
  }

  if (facts.unit_count === 1) {
    return execute("consume_review_handoff", {
      to: "FINAL_VERIFYING",
      reason: "SINGLE_UNIT_REUSE",
      reuse_final_review: true,
      // The reuse route is attempted only when `nexus run can` admits it.
      precheck: "FINAL_VERIFYING",
      fallback: { to: "FINAL_REVIEWING", reason: "FINAL_REVIEW_REQUIRED" },
    });
  }

  return execute("consume_review_handoff", { to: "FINAL_REVIEWING", reason: "LAST_UNIT_APPROVED" });
}

/* ------------------------------------------------------------------ executor */

function runNexus(worktree, argv, { timeoutMs } = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [nexusBin, ...argv], {
    cwd: worktree,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...process.env, NEXUS_WORKTREE: worktree },
  });
  return {
    ok: result.status === 0,
    exit_code: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    ms: Date.now() - started,
    argv,
  };
}

/**
 * The gate's own reasons, verbatim. Each stream is parsed separately so a JSON
 * rejection on stderr is not corrupted by unrelated stdout.
 */
function gateErrors(result) {
  for (const stream of [result.stderr, result.stdout]) {
    const text = String(stream || "");
    const start = text.indexOf("{");
    if (start === -1) continue;
    const candidate = text.slice(start, text.lastIndexOf("}") + 1);
    for (const attempt of [candidate, text.slice(start).split("\n")[0]]) {
      try {
        const parsed = JSON.parse(attempt);
        if (Array.isArray(parsed.errors) && parsed.errors.length > 0) return parsed.errors;
        if (parsed.error) return [String(parsed.error)];
      } catch {
        /* try the next candidate */
      }
    }
  }
  const raw = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  return raw ? [raw] : [];
}

/** Unit ids reach a filesystem path, so only a safe identifier is used there. */
const SAFE_UNIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function impactArtifactName(unitId, phase = "pre") {
  const safe = SAFE_UNIT_ID_RE.test(String(unitId || "")) ? String(unitId) : null;
  return safe ? `${phase}-${safe}.json` : `${phase}-unit.json`;
}

function impactArgs(unitId, targets, phase = "pre") {
  const out = path.join(".opencode", "impact", impactArtifactName(unitId, phase));
  return {
    argv: [
      "impact",
      "--json",
      "--phase",
      phase,
      "--targets",
      targets.join(","),
      "--out",
      out,
    ],
    out,
  };
}

/** Execute one planned step through the existing CLI gates. */
function executeStep(plan, facts, runner) {
  const { worktree, state } = facts;
  const step = plan.step;
  const commands = [];
  // Fail-closed: only steps on the reviewed allowlist can ever be executed.
  if (!EXECUTABLE_STEPS.includes(step)) {
    return {
      ok: false,
      step,
      commands,
      errors: [`advance refuses to execute unlisted step ${step}`],
    };
  }

  const run = (argv, opts) => {
    const result = runner(worktree, argv, opts);
    commands.push({
      argv: argv.join(" "),
      ok: result.ok,
      exit_code: result.exit_code,
      ms: result.ms,
    });
    return result;
  };

  switch (step) {
    case "start_brainstorming":
      return finish(run(["run", "transition", "--to", "BRAINSTORMING"]));

    case "plan_check_transition":
      return finish(run(["run", "transition", "--to", "PLANNED", "--plan-check"]));

    case "pre_impact": {
      const { argv, out } = impactArgs(plan.unit, plan.targets, "pre");
      const impact = run(argv);
      if (!impact.ok) return finish(impact);
      return finish(
        run([
          "run",
          "transition",
          "--to",
          "TASK_IMPACT_READY",
          "--impact",
          out,
          "--json",
          JSON.stringify({
            planned_targets: plan.targets,
            current_unit: plan.unit,
          }),
        ]),
      );
    }

    case "authorize_implementing": {
      const drift = run([
        "run",
        "drift",
        "--json",
        JSON.stringify({
          plan_commit: state.plan_commit || facts.head_commit,
          current_head: facts.head_commit,
        }),
      ]);
      if (!drift.ok) return finish(drift);
      let driftReport = null;
      try {
        driftReport = JSON.parse(drift.stdout);
      } catch {
        return finish({ ...drift, ok: false, stderr: "drift report was not JSON" });
      }
      return finish(
        run([
          "run",
          "transition",
          "--to",
          "IMPLEMENTING",
          "--branch",
          plan.branch,
          "--acceptance",
          plan.acceptance.join("|"),
          "--json",
          JSON.stringify({
            current_unit: plan.unit,
            allowed_files: plan.allowed_files,
            current_head: facts.head_commit,
            drift: driftReport,
          }),
        ]),
      );
    }

    case "consume_implementer_handoff":
      return finish(
        run([
          "run",
          "transition",
          "--to",
          "VERIFYING",
          "--implementer-handoff-file",
          plan.handoff_path,
        ]),
      );

    case "verify":
      return finish(run(["verify"]));

    case "verify_resume":
      return finish(run(["verify", "--resume"]));

    case "authorize_reviewing":
      return finish(run(["run", "transition", "--to", "REVIEWING"]));

    case "build_review_package":
      return finish(run(["review-package", "--scope", plan.scope, "--json"]));

    case "consume_review_handoff": {
      const evidence = {};
      if (plan.next_task) {
        evidence.next_task = true;
        evidence.current_unit = plan.unit;
      }
      if (plan.reuse_final_review) evidence.reuse_final_review = true;
      if (plan.to === "TASK_IMPACT_READY") evidence.planned_targets = plan.targets || [];

      let impactOut = null;
      if (plan.fresh_impact) {
        const { argv, out } = impactArgs(plan.unit, plan.targets || [], "pre");
        const impact = run(argv);
        if (!impact.ok) return finish(impact);
        impactOut = out;
      }

      const argvFor = (target, extra = {}) => {
        const argv = [
          "run",
          "transition",
          "--to",
          target,
          "--review-handoff-file",
          plan.handoff_path,
          "--json",
          JSON.stringify({ ...evidence, ...extra }),
        ];
        if (impactOut) argv.push("--impact", impactOut);
        return argv;
      };

      // Read-only eligibility question asked of the state machine itself, so the
      // optimistic route is never attempted against a gate that forbids it. Exit
      // 3 is the gate's own "not eligible"; anything else is a broken precheck
      // and must not be mistaken for an answer.
      if (plan.precheck) {
        const can = run([
          "run",
          "can-transition",
          "--to",
          plan.precheck,
          ...argvFor(plan.precheck).slice(4),
        ]);
        if (!can.ok && can.exit_code !== 3) {
          return finish(
            { ...can, ok: false, stderr: `eligibility precheck failed to run: ${can.stderr || can.stdout}` },
            { route: "PRECHECK_UNAVAILABLE" },
          );
        }
        if (!can.ok && plan.fallback) {
          const fallbackEvidence = { ...evidence };
          delete fallbackEvidence.reuse_final_review;
          const result = run([
            "run",
            "transition",
            "--to",
            plan.fallback.to,
            "--review-handoff-file",
            plan.handoff_path,
            "--json",
            JSON.stringify(fallbackEvidence),
          ]);
          return finish(result, { route: plan.fallback.reason });
        }
      }

      return finish(run(argvFor(plan.to)), { route: plan.reason });
    }

    case "authorize_completed":
      return finish(run(["run", "transition", "--to", "COMPLETED"]));

    default:
      return {
        ok: false,
        step,
        commands,
        errors: [`advance has no executor for step ${step}`],
      };
  }

  function finish(result, extra = {}) {
    return {
      ok: result.ok,
      step,
      commands,
      errors: result.ok ? [] : gateErrors(result),
      ...extra,
    };
  }
}

/**
 * Run the deterministic chain until the next boundary.
 *
 * @param {object} opts
 * @param {string} opts.worktree
 * @param {string} [opts.runId]
 * @param {number} [opts.maxSteps]
 * @param {boolean} [opts.dryRun] plan only; execute nothing
 * @param {(worktree: string, argv: string[]) => object} [opts.runner] injectable for tests
 * @param {{emit: Function}} [opts.telemetry]
 */
export function runAdvance(opts = {}) {
  const worktree = opts.worktree || process.cwd();
  const maxSteps = Math.max(
    1,
    Math.min(Number(opts.maxSteps) || ADVANCE_MAX_STEPS, ADVANCE_MAX_STEPS),
  );
  const runner = opts.runner || runNexus;
  const startedAt = Date.now();

  // Bind to one run id for the whole call: a run that reaches COMPLETED is no
  // longer the "active" run, and advance must still report its own last step.
  let runId = opts.runId || null;
  const load = () => {
    if (runId) return readRunState(worktree, runId);
    const active = latestActiveRunState(worktree);
    runId = active?.run_id || null;
    return active;
  };

  let state = null;
  try {
    state = load();
  } catch (err) {
    return {
      ok: false,
      version: ADVANCE_VERSION,
      error: String(err?.message || err),
      steps: [],
    };
  }

  const steps = [];
  const fromState = state?.state || null;
  let facts = collectFacts(worktree, state);
  let next = resolveNextAction(state, { worktree });
  let plan = planAdvanceStep(next, facts);
  let stopped = null;

  while (plan.execute) {
    if (steps.length >= maxSteps) {
      stopped = {
        boundary: "MANUAL",
        reason_code: "STEP_LIMIT_REACHED",
        instruction: `advance executed ${steps.length} deterministic steps; run it again to continue.`,
      };
      break;
    }
    if (opts.dryRun) {
      stopped = {
        boundary: "MANUAL",
        reason_code: "DRY_RUN",
        instruction: `Would execute ${plan.execute.step}.`,
        planned_step: plan.execute,
      };
      break;
    }

    // A step that succeeds without moving the run would otherwise repeat until
    // the step cap. Repeating the same step from the same state is a defect, not
    // progress: stop and report it.
    const previous = steps[steps.length - 1];
    if (
      previous &&
      previous.ok &&
      previous.step === plan.execute.step &&
      previous.from_state === (state?.state || null)
    ) {
      stopped = {
        boundary: "MANUAL",
        reason_code: "NO_PROGRESS",
        instruction: `Step ${plan.execute.step} succeeded without advancing ${state?.state}; inspect the run instead of repeating it.`,
      };
      break;
    }

    const outcome = executeStep(plan.execute, facts, runner);
    steps.push({
      step: outcome.step,
      action: next.action,
      from_state: state?.state || null,
      ok: outcome.ok,
      route: outcome.route || null,
      commands: outcome.commands,
      errors: outcome.errors,
    });
    if (!outcome.ok) {
      stopped = {
        boundary: "MANUAL",
        reason_code: "GATE_REJECTED",
        instruction: `Deterministic step ${outcome.step} was rejected; the gate's reason is authoritative. Advance does not retry with different evidence.`,
        errors: outcome.errors,
      };
      break;
    }

    const reloaded = load();
    if (!reloaded) {
      stopped = {
        boundary: "MANUAL",
        reason_code: "RUN_STATE_UNREADABLE",
        instruction: `Run state for ${runId || "the active run"} could not be re-read after ${outcome.step}.`,
      };
      break;
    }
    state = reloaded;
    facts = collectFacts(worktree, state);
    next = resolveNextAction(state, { worktree });
    plan = planAdvanceStep(next, facts);
  }

  if (!stopped) stopped = plan.stop;

  const result = {
    ok: stopped.boundary !== "MANUAL" || stopped.reason_code === "DRY_RUN",
    version: ADVANCE_VERSION,
    run_id: state?.run_id || null,
    from_state: fromState,
    state: state?.state || null,
    steps_executed: steps.length,
    steps,
    next: {
      action: next?.action || null,
      agent: next?.agent || null,
      skill: next?.skill || null,
      instruction: stopped.instruction || next?.instruction || null,
    },
    stopped: stopped,
    elapsed_ms: Date.now() - startedAt,
  };

  if (opts.telemetry?.emit) {
    opts.telemetry.emit({
      event: "advance",
      run_id: result.run_id,
      from_state: fromState,
      to_state: result.state,
      advance_steps: steps.length,
      advance_commands: steps.reduce(
        (total, entry) => total + (entry.commands?.length || 0),
        0,
      ),
      advance_ms: result.elapsed_ms,
      advance_boundary: stopped.boundary,
      advance_reason: stopped.reason_code,
    });
  }

  return result;
}

/** Human-readable rendering for terminal use. */
export function formatAdvance(result) {
  const lines = ["## Nexus Advance"];
  lines.push(`- run_id: ${result.run_id || "none"}`);
  lines.push(`- state: ${result.from_state || "none"} → ${result.state || "none"}`);
  lines.push(`- steps_executed: ${result.steps_executed}`);
  for (const step of result.steps || []) {
    const mark = step.ok ? "ok" : "FAILED";
    lines.push(
      `  - ${step.step}${step.route ? ` (${step.route})` : ""}: ${mark}` +
        (step.errors?.length ? ` — ${step.errors.join("; ")}` : ""),
    );
  }
  lines.push(`- boundary: ${result.stopped?.boundary} (${result.stopped?.reason_code})`);
  lines.push(`- do_now: ${result.stopped?.instruction || result.next?.instruction || ""}`);
  const dispatch = result.stopped?.dispatch;
  if (dispatch) {
    lines.push(`- dispatch_agent: ${dispatch.agent}`);
    if (dispatch.review_package_path) {
      lines.push(`- review_package: ${dispatch.review_package_path}`);
    }
    if (dispatch.allowed_files?.length) {
      lines.push(`- allowed_files: ${dispatch.allowed_files.join(", ")}`);
    }
    if (dispatch.prompt) lines.push(`- prompt: ${dispatch.prompt}`);
  }
  if (result.stopped?.errors?.length) {
    lines.push(`- gate_errors: ${result.stopped.errors.join("; ")}`);
  }
  return lines.join("\n");
}
