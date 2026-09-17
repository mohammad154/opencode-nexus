#!/usr/bin/env node
/**
 * Nexus workflow run CLI
 *
 * Exit codes: 0 ok, 2 validation failure, 3 illegal transition
 *
 * Commands:
 *   init --run-id <id>
 *   classify [--input file|--json '{}'] [classifier flags...]
 *   transition --to STATE [--evidence path] [--json '{}'] [--plan-check]
 *   validate-handoff --role ROLE --file path
 *   status [--run-id id]
 *   resume [--run-id id]
 *   verify [--run-id id] [--resume]
 */
import fs from "fs";
import path from "path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createEmptyRunState,
  writeRunState,
  readRunState,
  latestActiveRunState,
  inferRunFromContext,
  normalizeAndValidateHandoff,
} from "./lib/migrate-artifacts.js";
import { classify, loadWorkflowConfig, reclassifyAfterBlast } from "./lib/classify.js";
import {
  collectGitDiffEvidence,
  mergeGitDiffEvidence,
} from "./lib/diff-evidence.js";
import {
  transition as smTransition,
  canTransition,
  CLASSIFY_APPLY_SOURCE,
} from "./lib/state-machine.js";
import { createDefaultProviders } from "./lib/providers.js";
import { createVerificationProvider } from "./lib/providers/verification-provider.js";
import { runVerificationLifecycle } from "./lib/verification-lifecycle.js";
import { assessDrift } from "./lib/drift.js";
import { assertValidRunId } from "./lib/policy.js";
import {
  appendTrajectoryStep,
  readTrajectory,
} from "./lib/trajectory.js";
import {
  createTaskWorktree,
  removeTaskWorktree,
  listTaskWorktrees,
} from "./lib/worktree.js";
import {
  boundaryError,
  validateContainedPath,
} from "./lib/filesystem-boundary.js";

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out.flags[key] = true;
    else {
      out.flags[key] = next;
      i++;
    }
  }
  return out;
}

function worktree() {
  return process.env.NEXUS_WORKTREE || process.cwd();
}

const BASELINE_CAPTURE_STATES = new Set([
  "CREATED",
  "BRAINSTORMING",
  "WAITING_FOR_USER",
  "PLANNED",
  "TASK_IMPACT_READY",
]);

function baselineCaptureAllowed(state) {
  if (!state) return true;
  if (!BASELINE_CAPTURE_STATES.has(state.state)) return false;
  return !state.implementer_commit && !state.last_implementer_handoff;
}

function runIdForFlags(flags = {}) {
  if (flags["run-id"]) return String(flags["run-id"]);
  try {
    return latestActiveRunState(worktree())?.run_id || null;
  } catch {
    return null;
  }
}

function redact(value, key = "") {
  if (/(?:secret|token|password|passwd|api[_-]?key|authorization|cookie)/i.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return value.length > 4000 ? `${value.slice(0, 4000)}...[truncated]` : value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, item]) => [k, redact(item, k)]),
    );
  }
  return value;
}

function trajectoryFile(runId) {
  const root = path.resolve(worktree());
  const file = path.join(root, ".opencode", "trajectories", `${runId}.jsonl`);
  const boundary = validateContainedPath(root, file, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  if (!boundary.ok) throw boundaryError("trajectory path", boundary);
  return file;
}

function recordTrajectory(flags, action, observation, state, request = process.argv.slice(2)) {
  const runId = state?.run_id || runIdForFlags(flags);
  if (!runId) return;
  try {
    const file = trajectoryFile(runId);
    // Step is computed under a lockfile inside appendTrajectoryStep so concurrent
    // writers cannot select the same step number.
    appendTrajectoryStep(file, {
      run_id: runId,
      request: redact(request),
      action: redact(action),
      observation: redact(observation),
      state: redact(state || null),
      configuration: redact({
        profile: state?.profile || null,
        execution_mode: state?.execution_mode || null,
        cwd: worktree(),
      }),
    });
  } catch {
    // Trajectory capture is diagnostic; a corrupt or redirected runtime path
    // must never turn a fail-closed gate into an unsafe write or mask it with a
    // second exception.
  }
}

function failCli(flags, command, error, code = 2) {
  const message = String(error?.message || error);
  const state = (() => {
    try { return resolveRun(flags); } catch { return null; }
  })();
  recordTrajectory(flags, { command, failed: true }, { ok: false, error: message }, state);
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(code);
}

export function loadEvidence(flags) {
  let evidence = {};
  if (flags.evidence) {
    const p = flags.evidence;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    evidence = { ...raw, evidence_path: p };
  }
  if (flags.json) {
    evidence = { ...evidence, ...JSON.parse(flags.json) };
  }
  if (flags.classification) {
    evidence.classification = JSON.parse(
      fs.readFileSync(flags.classification, "utf8"),
    );
  }
  const implementerHandoffFile =
    flags["implementer-handoff-file"] || flags["handoff-file"];
  if (implementerHandoffFile) {
    evidence.implementer_handoff = JSON.parse(
      fs.readFileSync(implementerHandoffFile, "utf8"),
    );
  }
  if (flags["review-handoff-file"]) {
    evidence.review_handoff = JSON.parse(
      fs.readFileSync(flags["review-handoff-file"], "utf8"),
    );
  }
  if (flags["unified-handoff"]) {
    evidence.unified_handoff = JSON.parse(
      fs.readFileSync(flags["unified-handoff"], "utf8"),
    );
  }
  if (flags["spec-handoff"]) {
    evidence.spec_handoff = JSON.parse(
      fs.readFileSync(flags["spec-handoff"], "utf8"),
    );
  }
  if (flags["code-handoff"]) {
    evidence.code_handoff = JSON.parse(
      fs.readFileSync(flags["code-handoff"], "utf8"),
    );
  }
  if (flags.branch) evidence.branch = flags.branch;
  if (flags["plan-skip"]) {
    // Admin-only escape hatch — happy path must write PLAN.md
    evidence.plan_skip = true;
    evidence.admin_plan_skip = flags["admin-plan-skip"] === true;
    if (!evidence.admin_plan_skip) {
      evidence.compatibility_mode = evidence.compatibility_mode || "v3-admin";
      // Still require explicit admin flag in V5; bare --plan-skip alone fails gate
      delete evidence.plan_skip;
    }
  }
  if (flags["acceptance"]) {
    evidence.acceptance_criteria = String(flags.acceptance)
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (flags.blast) {
    evidence.blast = JSON.parse(fs.readFileSync(flags.blast, "utf8"));
  }
  if (flags.impact) {
    evidence.impact = JSON.parse(fs.readFileSync(flags.impact, "utf8"));
  }
  if (flags.graph) {
    evidence.graph = JSON.parse(fs.readFileSync(flags.graph, "utf8"));
  }
  evidence.worktree = worktree();
  return evidence;
}

function resolveRun(flags) {
  const wt = worktree();
  if (flags["run-id"]) {
    const s = readRunState(wt, flags["run-id"]);
    if (!s) {
      console.error(
        JSON.stringify({
          ok: false,
          error: `run not found: ${flags["run-id"]}`,
        }),
      );
      process.exit(2);
    }
    return s;
  }
  const latest = latestActiveRunState(wt);
  if (latest) return latest;
  return null;
}

function defaultRunId() {
  // Include time + random suffix so two `nexus run init` calls on the same UTC
  // date never collide on a single run_id (which would silently overwrite the
  // earlier run's state).
  const iso = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const suffix = randomBytes(3).toString("hex");
  return `run-${iso}-${suffix}`;
}

function runtimeFile(relativePath, label = "runtime path") {
  const root = path.resolve(worktree());
  const candidate = path.resolve(root, relativePath);
  const boundary = validateContainedPath(root, candidate, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  if (!boundary.ok) throw boundaryError(label, boundary);
  return candidate;
}

function cmdInit(flags) {
  const explicit = flags["run-id"];
  const id = explicit ? String(explicit) : defaultRunId();
  assertValidRunId(id);
  // Refuse to clobber an existing run unless --force is explicitly supplied.
  if (!flags.force) {
    // A malformed existing state is not equivalent to an absent state. Let
    // readRunState throw so init cannot silently destroy evidence of corruption.
    const existing = readRunState(worktree(), id);
    if (existing) {
      console.error(
        JSON.stringify({
          ok: false,
          error: `run_id already exists: ${id} (state=${existing.state}). Use a new --run-id or pass --force to overwrite.`,
        }),
      );
      process.exit(2);
    }
  }
  const state = createEmptyRunState(id, {
    workflow: "default",
  });
  writeRunState(worktree(), state);
  recordTrajectory(flags, { command: "init", run_id: id }, { ok: true, state }, state);
  console.log(JSON.stringify({ ok: true, state }, null, 2));
}

function cmdClassify(flags) {
  let input = {};
  if (flags.input) input = JSON.parse(fs.readFileSync(flags.input, "utf8"));
  if (flags.json) input = { ...input, ...JSON.parse(flags.json) };
  if (flags.files) input.filesChanged = Number(flags.files);
  if (flags.lines) input.estimatedLines = Number(flags.lines);
  if (flags.class) input.changeClass = flags.class;
  if (flags.focused) input.focusedValidation = true;
  if (flags.docs) input.documentationOnly = true;
  if (flags.security) input.securitySensitive = true;
  if (flags["public-api"]) input.publicApi = true;
  if (flags.migration) input.databaseMigration = true;
  if (flags["credential-handling"]) input.credentialHandling = true;
  if (flags["high-blast"]) input.blastRiskHigh = true;
  if (flags.profile) input.profileOverride = flags.profile;
  if (flags.callers != null) input.directCallers = Number(flags.callers);

  const diffRequested =
    flags.diff !== undefined || flags["from-diff"] !== undefined;
  // Git diff is authoritative by default. --no-diff is a compatibility escape
  // for non-repository callers and can never make a run direct-eligible.
  if (!flags["no-diff"]) {
    const rawBase =
      flags["from-diff"] !== undefined ? flags["from-diff"] : flags.diff;
    const diffBase = rawBase === true ? undefined : rawBase;
    const diffEvidence = collectGitDiffEvidence({
      cwd: worktree(),
      base: diffBase,
    });
    input = mergeGitDiffEvidence(input, diffEvidence);
    input.diff_verified = diffEvidence.diff_available === true;
  }

  const workflowConfig = loadWorkflowConfig();
  let result = classify(input, { workflowConfig });
  if (flags.blast && flags.blast !== true) {
    const blast = JSON.parse(fs.readFileSync(flags.blast, "utf8"));
    result = reclassifyAfterBlast(result, blast.report || blast, { workflowConfig });
  }
  let state = resolveRun(flags);
  if (state && flags.apply) {
    const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree(),
      encoding: "utf8",
    });
    const worktreeHead =
      headResult.status === 0
        ? String(headResult.stdout || "").trim() || null
        : null;
    const classification = {
      ...result,
      classification_source: CLASSIFY_APPLY_SOURCE,
      worktree_head: worktreeHead,
    };
    const { artifact_digest: _omit, ...forDigest } = classification;
    classification.artifact_digest = `sha256:${createHash("sha256")
      .update(JSON.stringify(forDigest))
      .digest("hex")}`;

    // Persist classification artifact for audit
    const classPath = runtimeFile(
      path.join(".opencode", "runs", state.run_id, "classification.json"),
      "classification artifact path",
    );
    fs.mkdirSync(path.dirname(classPath), { recursive: true });
    fs.writeFileSync(classPath, JSON.stringify(classification, null, 2) + "\n");

    // V5: classify is advisory only — does not advance run state.
    console.log(
      JSON.stringify(
        {
          ok: true,
          deprecated: true,
          warning:
            "V5: nexus classify --apply no longer transitions run state. Use brainstorming → PLANNED.",
          classification: result,
          state,
        },
        null,
        2,
      ),
    );
    return;
  }
  recordTrajectory(flags, { command: "classify", apply: false }, { ok: true, classification: result }, state);
  console.log(JSON.stringify(result, null, 2));
}

function resolvedRunUnits(state) {
  const candidates = [
    state?.execution_units,
    state?.units,
    state?.tasks,
    state?.task_count,
    state?.classification?.units,
    state?.plan_check?.execution_units,
    state?.plan_check?.tasks,
    state?.plan_check?.unit_count,
  ].filter((candidate) => candidate != null);
  const counts = candidates
    .map((candidate) => {
      if (Array.isArray(candidate)) return candidate.length;
      const count = Number(candidate);
      return Number.isInteger(count) && count >= 0 ? count : null;
    })
    .filter((count) => count != null && count > 0);
  return counts.length > 0 ? Math.max(...counts) : 1;
}

function cmdTransition(flags) {
  const to = flags.to;
  if (!to) {
    console.error(JSON.stringify({ ok: false, error: "--to required" }));
    process.exit(2);
  }
  let state = resolveRun(flags);
  if (!state) {
    console.error(
      JSON.stringify({ ok: false, error: "no run state; run init first" }),
    );
    process.exit(2);
  }
  const evidence = loadEvidence(flags);
  // Worktree binding is useful for digest-bound review reuse and never makes
  // caller-supplied provider artifacts authoritative by itself.
  // The CLI's selected worktree is authoritative. Never let an evidence file
  // redirect identity checks or state persistence to a different checkout.
  evidence.worktree = worktree();
  // PLANNED authority is recomputed inside the state-machine transition from
  // the canonical .opencode/plans/PLAN.md. The optional flag remains accepted
  // for CLI compatibility but cannot turn caller-supplied JSON into authority.
  const providers = createDefaultProviders({
    worktree: worktree(),
    profile: state.profile || state.classification?.profile,
    changeClass: state.change_class || state.classification?.change_class,
    executionMode: state.execution_mode || state.classification?.execution_mode,
    units: resolvedRunUnits(to === "PLANNED" ? { ...state, ...evidence } : state),
  });

  // Provider revalidation happens inside transition(); do not pre-inject
  // untrusted impact objects as authoritative when providers will rebuild.
  if (
    (to === "IMPACT_READY" || to === "TASK_IMPACT_READY") &&
    evidence.impact &&
    !evidence.impact_path
  ) {
    if (evidence.impact.trusted === true && !evidence.impact.provider_validated) {
      delete evidence.impact.trusted;
    }
  }
  if (
    (to === "IMPACT_READY" || to === "TASK_IMPACT_READY") &&
    evidence.blast &&
    !flags.blast &&
    !flags.impact
  ) {
    if (evidence.blast.trusted === true && !evidence.blast.provider_validated) {
      delete evidence.blast.trusted;
    }
  }

  if (flags.impact) {
    evidence.impact = JSON.parse(fs.readFileSync(flags.impact, "utf8"));
  }

  const r = smTransition(state, to, evidence, providers);
  if (!r.ok) {
    recordTrajectory(
      flags,
      { command: "transition", to, failed: true },
      { ok: false, errors: r.errors },
      state,
    );
    console.error(JSON.stringify({ ok: false, errors: r.errors }, null, 2));
    process.exit(3);
  }
  writeRunState(worktree(), r.state);
  recordTrajectory(
    flags,
    { command: "transition", to },
    { ok: true, state: r.state },
    r.state,
  );
  console.log(JSON.stringify({ ok: true, state: r.state }, null, 2));
}

function cmdValidateHandoff(flags) {
  const role = flags.role;
  const file = flags.file;
  if (!role || !file) {
    console.error(
      JSON.stringify({ ok: false, error: "--role and --file required" }),
    );
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const result = normalizeAndValidateHandoff(role, raw);
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(2);
  }
  if (flags.write) {
    fs.writeFileSync(file, JSON.stringify(result.data, null, 2) + "\n");
  }
  console.log(
    JSON.stringify(
      { ok: true, migrated_from: result.migrated_from, data: result.data },
      null,
      2,
    ),
  );
}

function cmdStatus(flags) {
  const state = resolveRun(flags);
  if (!state) {
    const inferred = inferRunFromContext(worktree());
    console.log(
      JSON.stringify({ ok: true, inferred: true, state: inferred }, null, 2),
    );
    return;
  }
  console.log(JSON.stringify({ ok: true, state }, null, 2));
}

function cmdResume(flags) {
  let state = resolveRun(flags);
  if (!state) {
    state = inferRunFromContext(worktree());
    // Persist synthesized run so resume is durable
    const { _inferred, ...rest } = state;
    writeRunState(worktree(), rest);
    recordTrajectory(flags, { command: "resume", inferred: true }, { ok: true, resumed: true, state: rest }, rest);
    console.log(
      JSON.stringify(
        {
          ok: true,
          resumed: true,
          inferred: true,
          state: rest,
          note: "synthesized from CONTEXT; did not invent approvals",
        },
        null,
        2,
      ),
    );
    return;
  }
  recordTrajectory(flags, { command: "resume", inferred: false }, { ok: true, resumed: true, state }, state);
  console.log(
    JSON.stringify(
      {
        ok: true,
        resumed: true,
        state,
        next_hint:
          state.state === "COMPLETED"
            ? "already complete"
            : `continue from ${state.state}`,
      },
      null,
      2,
    ),
  );
}

function cmdDrift(flags) {
  let input = {};
  if (flags.input) input = JSON.parse(fs.readFileSync(flags.input, "utf8"));
  if (flags.json) input = { ...input, ...JSON.parse(flags.json) };
  input.worktree = worktree();
  if (flags["plan-commit"]) input.plan_commit = flags["plan-commit"];
  if (flags["commit-distance"])
    input.commit_distance = Number(flags["commit-distance"]);
  const report = assessDrift(input);
  console.log(JSON.stringify(report, null, 2));
  if (report.drift === "HIGH") process.exit(2);
}

function cmdCan(flags) {
  const to = flags.to;
  const state = resolveRun(flags);
  if (!state || !to) {
    console.error(
      JSON.stringify({ ok: false, error: "need run state and --to" }),
    );
    process.exit(2);
  }
  const evidence = loadEvidence(flags);
  // Keep the advisory command bound to the checkout selected by the CLI too;
  // a caller-supplied evidence path must not bypass worktree identity checks.
  evidence.worktree = worktree();
  const r = canTransition(state, to, evidence);
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(3);
}

function cmdInspect(flags) {
  const state = resolveRun(flags);
  if (!state) {
    console.error(JSON.stringify({ ok: false, error: "no run state" }));
    process.exit(2);
  }
  const trajPath = trajectoryFile(state.run_id);
  let trajectory = [];
  if (fs.existsSync(trajPath)) {
    trajectory = readTrajectory(trajPath);
  }
  const report = {
    ok: true,
    run_id: state.run_id,
    state: state.state,
    profile: state.profile,
    review_level: state.review_level,
    impact: state.impact
      ? {
          risk: state.impact.risk,
          confidence: state.impact.confidence,
          artifact_digest: state.impact.artifact_digest,
          worktree_head: state.impact.worktree_head,
        }
      : null,
    transitions: state.transitions || [],
    trajectory_steps: trajectory.length,
    trajectory_path: fs.existsSync(trajPath) ? trajPath : null,
    gate_failures: trajectory
      .filter((s) => s.observation?.ok === false)
      .map((s) => ({ step: s.step, errors: s.observation?.errors })),
  };
  console.log(JSON.stringify(report, null, 2));
}

function cmdWorktree(subArgs, flags) {
  const subcmd = subArgs[1];
  const wt = worktree();
  if (!subcmd || subcmd === "help" || subcmd === "--help" || subcmd === "-h") {
    console.log(`Usage: nexus run worktree <create|list|remove> [flags]`);
    return;
  }
  switch (subcmd) {
    case "create": {
      const task = flags.task || flags["task-id"];
      if (!task) {
        console.error(JSON.stringify({ ok: false, error: "--task required" }, null, 2));
        process.exit(2);
      }
      const branch = flags.branch ? String(flags.branch) : undefined;
      const baseCommit = flags.base || flags["base-commit"] ? String(flags.base || flags["base-commit"]) : undefined;
      const result = createTaskWorktree(wt, task, { branch, baseCommit });
      if (!result.ok) {
        console.error(JSON.stringify(result, null, 2));
        process.exit(2);
      }
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "list": {
      const worktrees = listTaskWorktrees(wt);
      console.log(JSON.stringify({ ok: true, worktrees }, null, 2));
      break;
    }
    case "remove": {
      const task = flags.task || flags["task-id"];
      if (!task) {
        console.error(JSON.stringify({ ok: false, error: "--task required" }, null, 2));
        process.exit(2);
      }
      const result = removeTaskWorktree(wt, task);
      if (!result.ok) {
        console.error(JSON.stringify({ ok: false, task, ...result }, null, 2));
        process.exit(2);
      }
      console.log(JSON.stringify({ ok: true, task, ...result }, null, 2));
      break;
    }
    default: {
      console.error(`Unknown worktree subcommand: ${subcmd}`);
      process.exit(2);
    }
  }
}

function cmdBaseline(flags) {
  const provider = createVerificationProvider();
  const wt = worktree();
  const state = resolveRun(flags);
  const runId = state?.run_id || (flags["run-id"] ? String(flags["run-id"]) : null);
  if (!baselineCaptureAllowed(state)) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: "baseline capture is allowed only before implementation begins",
        },
        null,
        2,
      ),
    );
    process.exit(2);
  }
  const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: wt,
    encoding: "utf8",
  });
  const worktreeHead =
    headResult.status === 0 ? String(headResult.stdout || "").trim() || null : null;
  if (state && !worktreeHead) {
    console.error(
      JSON.stringify(
        { ok: false, error: "baseline capture requires a readable current Git HEAD" },
        null,
        2,
      ),
    );
    process.exit(2);
  }
  if (flags.commit && String(flags.commit) !== worktreeHead) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: `--commit must exactly match current Git HEAD ${worktreeHead || "(unavailable)"}`,
        },
        null,
        2,
      ),
    );
    process.exit(2);
  }
  const commit = worktreeHead;

  const baseline = provider.baseline({
    worktree: wt,
    runId,
    commit,
  });
  if (!baseline || baseline.ok !== true || baseline.persist_error) {
    const persistError = baseline?.persist_error || "persistence_failed";
    const error = `baseline capture could not be persisted (${persistError})`;
    recordTrajectory(
      flags,
      { command: "baseline", run_id: runId, failed: true },
      { ok: false, error, baseline },
      state,
    );
    console.error(JSON.stringify({ ok: false, error, baseline }, null, 2));
    process.exit(2);
  }
  recordTrajectory(flags, { command: "baseline", run_id: runId }, { ok: true, baseline }, state);
  console.log(JSON.stringify({ ok: true, baseline }, null, 2));
}

function cmdVerify(flags) {
  if (flags.baseline) {
    return cmdBaseline(flags);
  }
  const wt = worktree();
  const state = resolveRun(flags);
  const machineReadable = flags.json === true || flags.json === "true";

  if (state && ["VERIFYING", "FINAL_VERIFYING"].includes(state.state)) {
    const progress = (event) => {
      if (machineReadable) return;
      if (event.type === "run_start") {
        console.log(`Verification run: ${state.run_id}`);
        console.log(`HEAD: ${event.head || "unavailable"}`);
        console.log(`Phase: ${event.phase}`);
        return;
      }
      if (event.type === "plan_ready") {
        console.log(`Risk: ${event.risk || "UNKNOWN"}`);
        console.log(`Checks: ${event.executable_steps ?? "?"} executable / ${event.total || "?"} total steps`);
        return;
      }
      if (event.type === "step_start") {
        const total = event.total || "?";
        console.log(`[${event.index}/${total}] ${event.step?.id || "verification"} ... RUNNING`);
        return;
      }
      if (event.type === "step_reused") {
        const total = event.total || "?";
        console.log(`[${event.index}/${total}] ${event.step?.id || "verification"} ... REUSED`);
        return;
      }
      if (event.type === "step_complete") {
        const total = event.total || "?";
        const duration = event.result?.duration_ms;
        const suffix = Number.isFinite(duration) ? ` ${(duration / 1000).toFixed(1)}s` : "";
        console.log(
          `[${event.index}/${total}] ${event.step?.id || "verification"} ... ${event.result?.status || "DONE"}${suffix}`,
        );
      }
    };
    const result = runVerificationLifecycle({
      worktree: wt,
      state,
      resume: flags.resume === true,
      onProgress: progress,
    });
    recordTrajectory(
      flags,
      { command: "verify", resume: flags.resume === true, phase: result.phase || null },
      {
        ok: result.ok,
        code: result.code || null,
        error: result.error || null,
        verification_status: result.state?.verification_status || null,
      },
      result.state || state,
    );
    const body = {
      ok: result.ok,
      ...(result.code ? { code: result.code } : {}),
      ...(result.error ? { error: result.error } : {}),
      state: result.state || state,
      verification: result.verification || null,
      artifact: result.artifact || null,
    };
    if (machineReadable) {
      console.log(JSON.stringify(body, null, 2));
    } else if (result.ok) {
      console.log(`Verification PASSED`);
      const summary = result.state?.verification;
      if (summary?.total_steps != null) {
        console.log(`${summary.completed_steps || 0}/${summary.total_steps} verification steps completed`);
      }
      console.log(`Evidence sealed at HEAD ${result.state?.verification?.worktree_head || "unavailable"}`);
    } else {
      console.error(`Verification incomplete (${result.code || "VERIFICATION_FAILED"})`);
      console.error(`State remains ${result.state?.state || state.state}`);
      if (result.code === "VERIFICATION_TIMED_OUT") {
        console.error("Retry: nexus verify --resume");
      }
    }
    if (!result.ok) process.exit(2);
    return;
  }

  if (flags.resume === true) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "nexus verify --resume requires an active run in VERIFYING or FINAL_VERIFYING",
      }),
    );
    process.exit(2);
  }

  // Preserve the standalone measurement command for projects that have not
  // initialized a Nexus run. It is deliberately not an authorization step.
  const provider = createVerificationProvider();
  const runId = state?.run_id || (flags["run-id"] ? String(flags["run-id"]) : null);
  const run = provider.run({ worktree: wt, runId });
  if (flags.compare) {
    const baselinePath =
      flags.compare === true
        ? runId
          ? runtimeFile(
              path.join(".opencode", "runs", runId, "baseline.json"),
              "baseline artifact path",
            )
          : null
        : String(flags.compare);
    let baselineData = null;
    if (baselinePath && fs.existsSync(baselinePath)) {
      baselineData = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    }
    const comparison = provider.compare(baselineData, run);
    recordTrajectory(
      flags,
      { command: "verify", compare: true },
      { ok: comparison.ok, run, comparison },
      state,
    );
    console.log(JSON.stringify({ ok: comparison.ok, run, comparison }, null, 2));
    if (!comparison.ok) process.exit(2);
    return;
  }
  recordTrajectory(flags, { command: "verify" }, { ok: run.ok, run }, state);
  console.log(JSON.stringify({ ok: run.ok, run }, null, 2));
  if (!run.ok) process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const flags = args.flags;
  try {
    switch (cmd) {
      case "init":
        return cmdInit(flags);
      case "classify":
        return cmdClassify(flags);
      case "transition":
        return cmdTransition(flags);
      case "validate-handoff":
        return cmdValidateHandoff(flags);
      case "status":
        return cmdStatus(flags);
      case "resume":
        return cmdResume(flags);
      case "drift":
        return cmdDrift(flags);
      case "can-transition":
        return cmdCan(flags);
      case "inspect":
        return cmdInspect(flags);
      case "worktree":
        return cmdWorktree(args._, flags);
      case "baseline":
        return cmdBaseline(flags);
      case "verify":
        return cmdVerify(flags);
      default:
        console.error(
          `Unknown or missing command. Use: init|classify|transition|validate-handoff|status|resume|drift|can-transition|inspect|worktree|baseline|verify`,
        );
        process.exit(2);
    }
  } catch (e) {
    failCli(flags, cmd || "unknown", e, 2);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
