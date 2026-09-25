#!/usr/bin/env node
/**
 * CLI: nexus lane — guarded parallel execution.
 *
 * The plan's dependency waves have always been computed; lanes make one wave
 * executable. Independent units' implementers run concurrently in isolated
 * worktrees, and each lane's work is rebased onto the parent tip at join time so
 * the parent consumes it through its ordinary gates: fresh pre-impact, scope
 * lock, deterministic verification, one task review per unit, and PR8
 * convergence. No gate is skipped, relaxed, or given a parallel variant.
 *
 * Usage:
 *   nexus lane plan   [--json] [--max-concurrency N] [--run-id <id>]
 *   nexus lane start  --unit <id> [--json] [--run-id <id>] [--max-concurrency N]
 *   nexus lane status [--json] [--run-id <id>]
 *   nexus lane join   --unit <id> [--json] [--run-id <id>]
 *   nexus lane abort  --unit <id> [--json] [--run-id <id>] [--reason <text>]
 *
 * Exit codes:
 *   0  the command succeeded
 *   1  usage error
 *   2  no usable run state
 *   3  the command was refused by a guard (the reason is authoritative)
 */
import { latestActiveRunState, readRunState } from "./lib/migrate-artifacts.js";
import { DEFAULT_LANE_CONCURRENCY, formatLaneEligibility } from "./lib/lanes.js";
import { abortLane, joinLane, laneStatus, planLanes, startLane } from "./lib/lane-runtime.js";
import { createMetricsTelemetry } from "./lib/providers.js";

const USAGE = [
  "Usage:",
  "  nexus lane plan   [--json] [--max-concurrency N] [--run-id <id>]",
  "  nexus lane start  --unit <id> [--json] [--max-concurrency N]",
  "  nexus lane status [--json]",
  "  nexus lane join   --unit <id> [--json]",
  "  nexus lane abort  --unit <id> [--reason <text>] [--json]",
].join("\n");

function parseArgs(argv) {
  const out = {
    command: argv[0] && !argv[0].startsWith("-") ? argv[0] : null,
    json: false,
    unit: null,
    runId: null,
    reason: null,
    maxConcurrency: DEFAULT_LANE_CONCURRENCY,
    help: false,
  };
  for (let i = out.command ? 1 : 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--unit") out.unit = argv[++i];
    else if (a === "--run-id") out.runId = argv[++i];
    else if (a === "--reason") out.reason = argv[++i];
    else if (a === "--max-concurrency") out.maxConcurrency = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function emit(args, payload, exitCode) {
  const text = args.json ? JSON.stringify(payload, null, 2) : payload.text || "";
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${text}\n`);
  process.exit(exitCode);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(args.help ? 0 : 1);
  }
  const worktree = process.env.NEXUS_WORKTREE || process.cwd();
  const state = args.runId
    ? readRunState(worktree, args.runId)
    : latestActiveRunState(worktree)?.state || null;
  if (!state || typeof state !== "object") {
    emit(args, { ok: false, error: "NO_RUN_STATE", text: "No run state found." }, 2);
  }
  const telemetry = createMetricsTelemetry({ worktree });

  if (args.command === "plan") {
    const plan = planLanes(worktree, state, { maxConcurrency: args.maxConcurrency });
    telemetry.emit({
      event: "lane_plan",
      run_id: state.run_id || null,
      lane_wave_size: plan.wave.length,
      lane_max_concurrency: plan.max_concurrency,
      lane_open: plan.open_lanes.length,
      lane_excluded: plan.excluded.length,
    });
    emit(
      args,
      { ...plan, text: formatLaneEligibility(plan) },
      // A wave of one is a legitimate answer, not a failure: it means run the
      // unit sequentially. Only a broken schedule is an error.
      plan.errors.length > 0 ? 3 : 0,
    );
  }

  if (args.command === "status") {
    const status = laneStatus(worktree, state);
    if (status.ok === false) {
      emit(
        args,
        {
          ...status,
          text: [
            `lane ledger unusable (${status.code}):`,
            ...(status.errors || []).map((entry) => `- ${entry}`),
          ].join("\n"),
        },
        3,
      );
    }
    const text = [
      `parent tip: ${status.parent_tip || "unknown"}`,
      ...(status.lanes.length === 0
        ? ["no lanes"]
        : status.lanes.map(
            (lane) =>
              `${lane.unit} — ${lane.status}${lane.ready_to_join ? " (ready to join)" : ""} @ ${lane.tip_commit || "no commit"}`,
          )),
    ].join("\n");
    emit(args, { ...status, text }, 0);
  }

  if (!args.unit) {
    emit(args, { ok: false, error: "MISSING_UNIT", text: `--unit is required\n${USAGE}` }, 1);
  }

  if (args.command === "start") {
    const result = startLane(worktree, state, args.unit, {
      maxConcurrency: args.maxConcurrency,
    });
    telemetry.emit({
      event: "lane_start",
      run_id: state.run_id || null,
      lane_started: result.ok ? 1 : 0,
    });
    emit(
      args,
      {
        ...result,
        text: result.ok
          ? [
              `lane ${result.lane.unit} started`,
              `  worktree: ${result.lane.path}`,
              `  branch:   ${result.lane.branch}`,
              `  base:     ${result.lane.base_commit}`,
              `  scope:    ${result.lane.allowed_files.join(", ")}`,
              "",
              "Dispatch the implementer inside the lane worktree with fresh pre-impact",
              "evidence measured there, then `nexus lane join --unit " + result.lane.unit + "`.",
            ].join("\n")
          : (result.errors || []).map((e) => `- ${e}`).join("\n"),
      },
      result.ok ? 0 : 3,
    );
  }

  if (args.command === "join") {
    const result = joinLane(worktree, state, args.unit);
    telemetry.emit({
      event: "lane_join",
      run_id: state.run_id || null,
      lane_joined: result.ok ? 1 : 0,
      lane_join_refused: result.ok ? 0 : 1,
    });
    emit(
      args,
      {
        ...result,
        text: result.ok
          ? [
              `lane ${result.lane.unit} joined`,
              `  rebased onto: ${result.parent_tip}`,
              `  commit:       ${result.joined_commit}`,
              `  files:        ${result.files.join(", ")}`,
              `  handoff:      ${result.handoff_path}`,
              "",
              "The parent now holds this work as an ordinary implementer handoff.",
              "Run `nexus advance` to verify and review it through the normal gates.",
            ].join("\n")
          : [`lane join refused (${result.code}):`, ...(result.errors || []).map((e) => `- ${e}`)].join(
              "\n",
            ),
      },
      result.ok ? 0 : 3,
    );
  }

  if (args.command === "abort") {
    const result = abortLane(worktree, state, args.unit, { reason: args.reason });
    telemetry.emit({
      event: "lane_abort",
      run_id: state.run_id || null,
      lane_aborted: result.ok ? 1 : 0,
    });
    emit(
      args,
      {
        ...result,
        text: result.ok
          ? `lane ${args.unit} abandoned${result.worktree_removed ? " and its worktree removed" : ""}; the unit is unimplemented and must still be completed`
          : (result.errors || []).map((e) => `- ${e}`).join("\n"),
      },
      result.ok ? 0 : 3,
    );
  }

  emit(args, { ok: false, error: "UNKNOWN_COMMAND", text: USAGE }, 1);
}

main();
