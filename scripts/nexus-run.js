#!/usr/bin/env node
/**
 * Nexus workflow run CLI
 *
 * Exit codes: 0 ok, 2 validation failure, 3 illegal transition
 *
 * Commands:
 *   init --run-id <id>
 *   classify [--input file|--json '{}'] [classifier flags...]
 *   transition --to STATE [--evidence path] [--json '{}']
 *   validate-handoff --role ROLE --file path
 *   status [--run-id id]
 *   resume [--run-id id]
 */
import fs from "fs";
import path from "path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createEmptyRunState,
  writeRunState,
  readRunState,
  latestRunState,
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

function runIdForFlags(flags = {}) {
  if (flags["run-id"]) return String(flags["run-id"]);
  try {
    return latestRunState(worktree())?.run_id || null;
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
  return path.join(worktree(), ".opencode", "trajectories", `${runId}.jsonl`);
}

function recordTrajectory(flags, action, observation, state, request = process.argv.slice(2)) {
  const runId = state?.run_id || runIdForFlags(flags);
  if (!runId) return;
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

function loadEvidence(flags) {
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
  if (flags["handoff-file"]) {
    evidence.implementer_handoff = JSON.parse(
      fs.readFileSync(flags["handoff-file"], "utf8"),
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
  if (flags["plan-skip"]) evidence.plan_skip = true;
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
  const latest = latestRunState(wt);
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

function cmdInit(flags) {
  const explicit = flags["run-id"];
  const id = explicit ? String(explicit) : defaultRunId();
  assertValidRunId(id);
  // Refuse to clobber an existing run unless --force is explicitly supplied.
  const existing = (() => {
    try {
      return readRunState(worktree(), id);
    } catch {
      return null;
    }
  })();
  if (existing && !flags.force) {
    console.error(
      JSON.stringify({
        ok: false,
        error: `run_id already exists: ${id} (state=${existing.state}). Use a new --run-id or pass --force to overwrite.`,
      }),
    );
    process.exit(2);
  }
  const state = createEmptyRunState(id, {
    profile: flags.profile || "balanced",
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
    const classPath = path.join(
      worktree(),
      ".opencode",
      "runs",
      state.run_id,
      "classification.json",
    );
    fs.mkdirSync(path.dirname(classPath), { recursive: true });
    fs.writeFileSync(classPath, JSON.stringify(classification, null, 2) + "\n");

    const r = smTransition(
      state,
      "CLASSIFIED",
      {
        classification,
        classification_source: CLASSIFY_APPLY_SOURCE,
      },
      createDefaultProviders({ worktree: worktree() }),
    );
    if (!r.ok) {
      console.error(
        JSON.stringify(
          { ok: false, errors: r.errors, classification: result },
          null,
          2,
        ),
      );
      process.exit(3);
    }
    writeRunState(worktree(), r.state);
    recordTrajectory(
      flags,
      { command: "classify", apply: true },
      { ok: true, classification: result, state: r.state },
      r.state,
    );
    console.log(
      JSON.stringify(
        { ok: true, classification: result, state: r.state },
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
  const candidate =
    state?.units ??
    state?.execution_units ??
    state?.classification?.units;
  if (Array.isArray(candidate)) return Math.max(1, candidate.length);
  const units = Number(candidate);
  return Number.isFinite(units) && units > 0 ? Math.floor(units) : 1;
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
  const providers = createDefaultProviders({
    worktree: worktree(),
    profile: state.profile || state.classification?.profile,
    changeClass: state.change_class || state.classification?.change_class,
    executionMode: state.execution_mode || state.classification?.execution_mode,
    units: resolvedRunUnits(state),
  });

  // Provider revalidation happens inside transition(); do not pre-inject
  // untrusted impact objects as authoritative when providers will rebuild.
  if (to === "IMPACT_READY" && evidence.impact && !evidence.impact_path) {
    if (evidence.impact.trusted === true && !evidence.impact.provider_validated) {
      delete evidence.impact.trusted;
    }
  }
  if (to === "IMPACT_READY" && evidence.blast && !flags.blast && !flags.impact) {
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
  const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: wt,
    encoding: "utf8",
  });
  const worktreeHead =
    headResult.status === 0 ? String(headResult.stdout || "").trim() || null : null;
  const commit = flags.commit ? String(flags.commit) : worktreeHead;

  const baseline = provider.baseline({
    worktree: wt,
    runId,
    commit,
  });
  recordTrajectory(flags, { command: "baseline", run_id: runId }, { ok: true, baseline }, state);
  console.log(JSON.stringify({ ok: true, baseline }, null, 2));
}

function cmdVerify(flags) {
  if (flags.baseline) {
    return cmdBaseline(flags);
  }
  const provider = createVerificationProvider();
  const wt = worktree();
  const state = resolveRun(flags);
  const runId = state?.run_id || (flags["run-id"] ? String(flags["run-id"]) : null);
  const run = provider.run({ worktree: wt, runId });
  if (flags.compare) {
    const baselinePath =
      flags.compare === true
        ? runId
          ? path.join(wt, ".opencode", "runs", runId, "baseline.json")
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

main();
