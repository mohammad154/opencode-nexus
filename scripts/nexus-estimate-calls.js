#!/usr/bin/env node
/**
 * Estimate minimum agent calls for a Nexus plan.
 *
 * Usage:
 *   node scripts/nexus-estimate-calls.js --tasks 5
 *   node scripts/nexus-estimate-calls.js --units 3 --planning-mode standard
 *   node scripts/nexus-estimate-calls.js --plan .opencode/plans/PLAN.md
 */
import fs from "node:fs";
import path from "node:path";
import { estimateAgentCalls } from "./lib/agent-estimate.js";
import { parsePlanMarkdown } from "./lib/plan-check.js";
import { inferPlanningMode, normalizePlanningMode } from "./lib/planning.js";

const args = process.argv.slice(2);
function flag(name, def = undefined) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  const value = args[i + 1];
  return value == null || value.startsWith("--") ? def : value;
}
function hasFlag(name) {
  return args.includes(name);
}

let plan = null;
const planPath = flag("--plan");
if (planPath) {
  const absolute = path.resolve(planPath);
  if (fs.existsSync(absolute)) plan = parsePlanMarkdown(fs.readFileSync(absolute, "utf8"));
}

const rawUnits = plan?.execution_units?.length || flag("--units") || flag("--tasks", "3");
const units = Math.max(1, parseInt(rawUnits, 10) || 3);
const fixLoops = Math.max(0, parseInt(flag("--fix-loops", "0"), 10) || 0);
const requestedMode = flag("--planning-mode");
const inferredMode = plan
  ? inferPlanningMode({ unit_count: units })
  : hasFlag("--advisor")
    ? "standard"
    : "compact";
const planningMode = normalizePlanningMode(
  requestedMode || plan?.planning_mode || inferredMode,
  "compact",
);
const advisorCalls = hasFlag("--advisor")
  ? Math.max(1, parseInt(flag("--advisor-calls", "1"), 10) || 1)
  : undefined;
const estimate = estimateAgentCalls({
  units,
  fixLoops,
  planningMode,
  advisorCalls,
  criticalDisagreement: hasFlag("--critical-disagreement"),
  singleUnitFinalReviewReuse: hasFlag("--reuse-single-final"),
});

const out = {
  ok: true,
  workflow: "default",
  version: "5.1",
  plan_path: planPath || null,
  tasks: estimate.tasks,
  units: estimate.units,
  planning_mode: estimate.planning_mode,
  fix_loops_assumed: fixLoops,
  plan_advisor_calls: estimate.plan_advisor_calls,
  calls: estimate.calls,
  formula: estimate.formula,
  notes: [
    "V5 has no fast/balanced/strict profile matrix.",
    "Execution-unit count, not implementation-step count, drives implementer and reviewer calls.",
    "Plan Advisor is planning-only and normally adds at most one call for standard/deep planning.",
    "Every implementer dispatch requires fresh pre-impact (script, not an agent call).",
    "Generate review packages with: nexus review-package --scope task|final",
  ],
};

console.log(JSON.stringify(out, null, 2));
