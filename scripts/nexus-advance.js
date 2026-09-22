#!/usr/bin/env node
/**
 * CLI: nexus advance — run the deterministic chain of the orchestrator loop up
 * to the next agent/user boundary and return the prepared dispatch.
 *
 * Usage:
 *   nexus advance [--json] [--run-id <id>] [--max-steps N] [--dry-run]
 *
 * Exit codes:
 *   0  advanced to a boundary (agent dispatch, user answer, self work, done)
 *   2  no run state / unusable input
 *   3  a deterministic gate rejected a step (its reason is authoritative)
 */
import { runAdvance, formatAdvance, ADVANCE_MAX_STEPS } from "./lib/advance.js";
import { createMetricsTelemetry } from "./lib/providers.js";

function parseArgs(argv) {
  const out = {
    json: false,
    runId: null,
    maxSteps: ADVANCE_MAX_STEPS,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--run-id") out.runId = argv[++i];
    else if (a === "--max-steps") out.maxSteps = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: nexus advance [--json] [--run-id <id>] [--max-steps N] [--dry-run]\n",
    );
    process.exit(0);
  }
  const worktree = process.env.NEXUS_WORKTREE || process.cwd();
  const result = runAdvance({
    worktree,
    runId: args.runId,
    maxSteps: args.maxSteps,
    dryRun: args.dryRun,
    telemetry: createMetricsTelemetry({ worktree }),
  });

  const text = args.json
    ? JSON.stringify(result, null, 2)
    : formatAdvance(result);
  if (result.ok) process.stdout.write(`${text}\n`);
  else process.stderr.write(`${text}\n`);

  if (result.error) process.exit(2);
  if (!result.ok) process.exit(3);
  process.exit(0);
}

main();
