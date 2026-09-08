#!/usr/bin/env node
/** Deterministic PLAN.md linter; it never calls an LLM and never edits a plan. */
import fs from "node:fs";
import path from "node:path";
import { checkPlan, checkPlanFile } from "./lib/plan-check.js";

const HELP = `Usage: nexus plan-check [options]

Options:
  --plan PATH             Plan markdown path (default: .opencode/plans/PLAN.md)
  --input PATH            JSON plan input instead of markdown
  --strict                Treat linter warnings as a failed check
  --planning-mode MODE    compact|standard|deep (override plan metadata)
  --fix-loops N           Include assumed reviewer fix loops in the estimate
  --reuse-single-final    Estimate digest-bound single-unit final-review reuse
  --json                  Print machine-readable JSON
  -h, --help              Show this message
`;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") flags.help = true;
    else if (arg === "--strict" || arg === "--json" || arg === "--reuse-single-final") flags[arg.slice(2)] = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value == null || value.startsWith("--")) flags[key] = true;
      else {
        flags[key] = value;
        i += 1;
      }
    }
  }
  return flags;
}

function humanReport(result) {
  const lines = [
    "PLAN CHECK",
    "",
    `Plan: ${result.plan_path || "inline"}`,
    `Planning mode: ${result.planning_mode || "unknown"}`,
    `Execution units: ${result.unit_count}`,
    `Estimated agent calls: ${result.estimate.calls.total}`,
    `Estimated budget ceiling: ${result.estimate.calls.budget_ceiling}`,
  ];
  if (result.errors.length > 0) {
    lines.push("", "Errors:");
    for (const error of result.errors) lines.push(`- ${error.message}`);
  }
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of result.warnings) lines.push(`- ${warning.message}`);
  }
  if (result.merge_candidates.length > 0) {
    lines.push("", `Suggested decomposition: ${result.suggested_unit_count} unit(s)`);
  }
  lines.push("", `${result.plan_check}${result.ok ? "" : " — action required"}`);
  return lines.join("\n");
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP.trimEnd());
    return;
  }
  const options = {
    strict: flags.strict === true,
    planningMode: flags["planning-mode"],
    fixLoops: flags["fix-loops"],
    singleUnitFinalReviewReuse: flags["reuse-single-final"] === true,
  };
  let result;
  if (flags.input) {
    const inputPath = path.resolve(String(flags.input));
    if (!fs.existsSync(inputPath)) {
      result = checkPlanFile(inputPath, options);
    } else {
      try {
        result = checkPlan(JSON.parse(fs.readFileSync(inputPath, "utf8")), options);
        result.plan_path = flags.input;
      } catch (error) {
        result = {
          ok: false,
          plan_check: "FAIL",
          plan_path: flags.input,
          source: "invalid-json",
          unit_count: 0,
          execution_units: [],
          tasks: [],
          planning_mode: null,
          errors: [{ code: "INVALID_JSON", message: `unable to read JSON plan: ${error.message}` }],
          warnings: [],
          merge_candidates: [],
          suggested_unit_count: 0,
        };
      }
    }
  } else {
    result = checkPlanFile(
      flags.plan || path.join(process.cwd(), ".opencode", "plans", "PLAN.md"),
      options,
    );
  }

  if (flags.json === true) console.log(JSON.stringify(result, null, 2));
  else console.log(humanReport(result));
  if (!result.ok) process.exit(2);
}

main();
