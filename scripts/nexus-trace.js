#!/usr/bin/env node
/**
 * CLI: nexus trace — show the traceability matrix for a run: declared
 * requirements, planned execution units, their stable acceptance-criterion ids,
 * and the approved review evidence that demonstrated each one.
 *
 * Read-only. It reports the same computation the convergence gate performs, so
 * "why can this run not complete?" is answerable without re-reading PLAN.md.
 *
 * Usage:
 *   nexus trace [--json] [--run-id <id>]
 *
 * Exit codes:
 *   0  the run has converged (every planned criterion covered)
 *   2  no usable run state
 *   3  the run has not converged (uncovered units, criteria, or requirements)
 */
import { latestActiveRunState, readRunState } from "./lib/migrate-artifacts.js";
import {
  convergenceErrors,
  formatTrace,
  traceMatrix,
} from "./lib/traceability.js";
import { createMetricsTelemetry } from "./lib/providers.js";

function parseArgs(argv) {
  const out = { json: false, runId: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--run-id") out.runId = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("Usage: nexus trace [--json] [--run-id <id>]\n");
    process.exit(0);
  }
  const worktree = process.env.NEXUS_WORKTREE || process.cwd();
  const state = args.runId
    ? readRunState(worktree, args.runId)
    : latestActiveRunState(worktree)?.state || null;
  if (!state || typeof state !== "object") {
    const message = { ok: false, error: "NO_RUN_STATE" };
    process.stderr.write(
      `${args.json ? JSON.stringify(message, null, 2) : "No run state found."}\n`,
    );
    process.exit(2);
  }

  const matrix = traceMatrix(state);
  const errors = convergenceErrors(state, { label: "COMPLETED" });
  // A verdict accepted in the current transition is recorded by the reducer
  // afterwards. Show it as pending so the report is not confusing, but never
  // count it as coverage: the ledger is the authority.
  const pendingApproval = (() => {
    const handoff = state.last_task_review_handoff;
    if (!handoff || handoff.verdict !== "APPROVED") return null;
    const unit = String(state.current_unit || handoff.unit_or_task || "");
    const recorded = matrix.units.find((row) => row.unit === unit);
    if (!unit || !recorded || recorded.reviewed) return null;
    return { unit, reviewed_commit: handoff.reviewed_commit || null };
  })();
  const report = {
    ok: errors.length === 0,
    run_id: state.run_id || null,
    state: state.state || null,
    ...matrix,
    pending_approval: pendingApproval,
    errors,
  };

  createMetricsTelemetry({ worktree }).emit({
    event: "trace",
    run_id: state.run_id || null,
    trace_units_planned: matrix.summary.units_planned,
    trace_units_reviewed: matrix.summary.units_reviewed,
    trace_criteria_planned: matrix.summary.criteria_planned,
    trace_criteria_covered: matrix.summary.criteria_covered,
    trace_requirements_declared: matrix.summary.requirements_declared,
    trace_requirements_covered: matrix.summary.requirements_covered,
    trace_converged: matrix.summary.converged ? 1 : 0,
  });

  const text = args.json
    ? JSON.stringify(report, null, 2)
    : [
        formatTrace(matrix),
        ...(pendingApproval
          ? [
              "",
              `Pending (approved, not yet recorded by a transition): ${pendingApproval.unit} at ${pendingApproval.reviewed_commit || "unknown commit"}`,
            ]
          : []),
        ...(errors.length ? ["", ...errors.map((e) => `- ${e}`)] : []),
      ].join("\n");
  process.stdout.write(`${text}\n`);
  process.exit(report.ok ? 0 : 3);
}

main();
