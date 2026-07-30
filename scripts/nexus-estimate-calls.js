#!/usr/bin/env node
/**
 * Estimate minimum agent calls for a Nexus plan under a workflow profile.
 * This is a call-count estimate, not a monetary-cost estimate.
 *
 * Usage:
 *   node scripts/nexus-estimate-calls.js --tasks 5 --profile balanced
 *   node scripts/nexus-estimate-calls.js --tasks 5 --profile strict --units 2
 */
"use strict";

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  return args[i + 1] ?? def;
}

const tasks = Math.max(1, parseInt(flag("--tasks", "3"), 10) || 3);
const requestedProfile = (flag("--profile", "balanced") || "balanced")
  .trim()
  .toLowerCase();
const profile = new Set(["fast", "balanced", "strict"]).has(requestedProfile)
  ? requestedProfile
  : "balanced";
const units = Math.max(
  1,
  parseInt(flag("--units", String(Math.ceil(tasks / 3))), 10) || 1,
);
const changeClass = (flag("--class", "small-feature-with-tests") || "")
  .trim()
  .toLowerCase();
const executionMode = (
  flag("--mode", flag("--execution-mode", "")) || ""
).trim().toLowerCase();
const direct = args.includes("--direct") || executionMode === "direct" || changeClass === "direct";

const DUAL_REVIEW_CLASSES = new Set([
  "public-api",
  "authentication-security",
  "database-migration",
  "high-blast",
]);

function callsForUnit(category) {
  if (category === "documentation" || category === "direct") return 1;
  return category === "dual" ? 3 : 2;
}

function breakdownFor(category, count) {
  const breakdown = {
    implementer: count,
    unified_reviewer: 0,
    spec_reviewer: 0,
    code_reviewer: 0,
    cleanup_agent: 0,
    scripts: "graph/blast/cleanup",
  };
  if (category === "normal") breakdown.unified_reviewer = count;
  if (category === "dual") {
    breakdown.spec_reviewer = count;
    breakdown.code_reviewer = count;
  }
  return breakdown;
}

function estimate(p) {
  // Strict is per-task by default; fast and balanced batch into execution
  // units. Documentation and direct work remain implementer-only in every
  // profile, including strict.
  const count = p === "strict" ? tasks : units;
  const category = direct
    ? "direct"
    : changeClass === "documentation"
      ? "documentation"
      : p === "strict" || DUAL_REVIEW_CLASSES.has(changeClass)
        ? "dual"
        : "normal";
  const minCalls = count * callsForUnit(category);

  if (category === "direct" || category === "documentation") {
    return {
      profile: p,
      minCalls,
      breakdown: breakdownFor(category, count),
      note: category === "direct"
        ? "Direct work: implementer only; verification is scripted."
        : "Documentation-only: implementer only; verification is scripted.",
    };
  }

  if (category === "dual") {
    return {
      profile: p,
      minCalls,
      breakdown: breakdownFor(category, count),
      note: p === "strict"
        ? "Strict work: implementer plus spec and code reviewers per task."
        : "High-risk work: implementer plus spec and code reviewers per execution unit.",
    };
  }

  return {
    profile: p,
    minCalls,
    breakdown: breakdownFor(category, count),
    note: "Batched by execution unit; risk-based unified review.",
  };
}

const strict = estimate("strict");
const chosen = estimate(profile);
const savings = strict.minCalls - chosen.minCalls;

const out = {
  estimator: "nexus-estimate-calls",
  estimation_type: "agent_calls",
  unit: "agent_calls",
  tasks,
  units,
  change_class: changeClass,
  execution_mode: executionMode || (direct ? "direct" : "delegated"),
  recommended_profile: profile,
  estimated_agent_calls: chosen.minCalls,
  strict_equivalent_agent_calls: strict.minCalls,
  saved_agent_calls: Math.max(0, savings),
  // Compatibility aliases for hosts that consumed the first renamed output.
  estimated_calls: chosen.minCalls,
  strict_equivalent_calls: strict.minCalls,
  savings: Math.max(0, savings),
  breakdown: chosen.breakdown,
  reason: chosen.note,
  message: `Recommended profile: ${profile}\nEstimated agent calls: ${chosen.minCalls} instead of ${strict.minCalls} (strict)\nReason: ${chosen.note}`,
};

console.log(out.message);
console.log(JSON.stringify(out, null, 2));
