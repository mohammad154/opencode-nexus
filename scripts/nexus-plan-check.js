#!/usr/bin/env node
/** Deterministic PLAN.md linter; it never calls an LLM and never edits a plan. */
import fs from "node:fs";
import path from "node:path";
import { estimateAgentCalls } from "./lib/agent-estimate.js";
import { checkPlan, checkPlanFile } from "./lib/plan-check.js";

const HELP = `Usage: nexus plan-check [options]

Options:
  --plan PATH             Plan markdown path (default: .opencode/plans/PLAN.md)
  --input PATH            JSON plan input instead of markdown
  --strict                Treat linter warnings as a failed check
  --allow-undispositioned-warnings
                          Diagnostic mode; do not require warning dispositions
  --planning-mode MODE    compact|standard|deep (override plan metadata)
  --fix-loops N           Include assumed reviewer fix loops in the estimate
  --reuse-single-final    Estimate digest-bound single-unit final-review reuse
  --json                  Print machine-readable JSON
  -h, --help              Show this message
`;

const BOOLEAN_OPTIONS = new Set([
  "allow-undispositioned-warnings",
  "help",
  "json",
  "reuse-single-final",
  "strict",
]);
const VALUE_OPTIONS = new Set([
  "fix-loops",
  "input",
  "plan",
  "planning-mode",
]);

function parseArgs(argv) {
  const flags = {};
  const errors = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      errors.push({
        code: "UNEXPECTED_ARGUMENT",
        message: `unexpected argument: ${arg}`,
      });
      continue;
    }
    const key = arg.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      flags[key] = true;
      continue;
    }
    if (VALUE_OPTIONS.has(key)) {
      const value = argv[i + 1];
      if (value == null || value.startsWith("--")) {
        errors.push({
          code: "MISSING_OPTION_VALUE",
          message: `--${key} requires a value`,
        });
        continue;
      }
      flags[key] = value;
      i += 1;
      continue;
    }
    errors.push({
      code: "UNKNOWN_OPTION",
      message: `unknown option: --${key}`,
    });
  }
  return { flags, errors };
}

function validationFailure(errors, { planPath = null, source = "validation" } = {}) {
  return {
    ok: false,
    plan_check: "FAIL",
    plan_path: planPath,
    source,
    unit_count: 0,
    execution_units: [],
    tasks: [],
    planning_mode: null,
    errors,
    warnings: [],
    merge_candidates: [],
    warning_dispositions: [],
    disposition_errors: [],
    merge_matching_size: 0,
    suggested_unit_count: 0,
    estimate: estimateAgentCalls({ units: 1 }),
  };
}

function humanReport(result) {
  const estimate = result.estimate || { calls: { total: 0, budget_ceiling: 0 } };
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const mergeCandidates = Array.isArray(result.merge_candidates)
    ? result.merge_candidates
    : [];
  const lines = [
    "PLAN CHECK",
    "",
    `Plan: ${result.plan_path || "inline"}`,
    `Planning mode: ${result.planning_mode || "unknown"}`,
    `Execution units: ${result.unit_count}`,
    `Estimated agent calls: ${estimate.calls.total}`,
    `Estimated budget ceiling: ${estimate.calls.budget_ceiling}`,
  ];
  if (errors.length > 0) {
    lines.push("", "Errors:");
    for (const error of errors) lines.push(`- ${error.message || error}`);
  }
  if (warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of warnings) lines.push(`- ${warning.message || warning}`);
  }
  if (mergeCandidates.length > 0) {
    lines.push("", `Suggested decomposition: ${result.suggested_unit_count} unit(s)`);
  }
  lines.push("", `${result.plan_check}${result.ok ? "" : " — action required"}`);
  return lines.join("\n");
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const flags = parsed.flags;
  if (flags.help) {
    console.log(HELP.trimEnd());
    return;
  }
  if (parsed.errors.length > 0) {
    const result = validationFailure(parsed.errors, {
      planPath: typeof flags.plan === "string" ? flags.plan : null,
      source: "invalid-arguments",
    });
    if (flags.json === true) console.log(JSON.stringify(result, null, 2));
    else console.log(humanReport(result));
    process.exit(2);
  }
  const options = {
    strict: flags.strict === true,
    requireWarningDispositions:
      flags["allow-undispositioned-warnings"] !== true,
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
        result = validationFailure(
          [{ code: "INVALID_JSON", message: `unable to read JSON plan: ${error.message}` }],
          { planPath: flags.input, source: "invalid-json" },
        );
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
