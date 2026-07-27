#!/usr/bin/env node
/**
 * Estimate minimum subagent calls for a Nexus plan under a workflow profile.
 * Usage:
 *   node scripts/nexus-estimate-cost.js --tasks 5 --profile balanced
 *   node scripts/nexus-estimate-cost.js --tasks 5 --profile strict --units 2
 */
"use strict";

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  return args[i + 1] ?? def;
}

const tasks = Math.max(1, parseInt(flag("--tasks", "3"), 10) || 3);
const profile = (flag("--profile", "balanced") || "balanced").toLowerCase();
const units = Math.max(
  1,
  parseInt(flag("--units", String(Math.ceil(tasks / 3))), 10) || 1,
);
const changeClass = flag("--class", "small-feature-with-tests");

function estimate(p) {
  if (p === "strict") {
    // implementer + spec + code + (cleanup was agent; now script=0)
    const per = 3;
    return {
      profile: p,
      minCalls: tasks * per,
      breakdown: {
        implementer: tasks,
        spec_reviewer: tasks,
        code_reviewer: tasks,
        cleanup_agent: 0,
        scripts: "graph/blast/cleanup",
      },
      note: "Per-task dual review. Cleanup is scripted (0 LLM).",
    };
  }
  if (p === "fast") {
    const dual = [
      "public-api",
      "authentication-security",
      "database-migration",
      "high-blast",
    ].includes(changeClass);
    if (dual) {
      return {
        profile: p,
        minCalls: units * 3,
        breakdown: {
          implementer: units,
          spec_reviewer: units,
          code_reviewer: units,
          cleanup_agent: 0,
        },
        note: "Escalated to dual review due to change class.",
      };
    }
    const skip = changeClass === "documentation";
    return {
      profile: p,
      minCalls: skip ? units : units * 2,
      breakdown: {
        implementer: units,
        unified_reviewer: skip ? 0 : units,
        cleanup_agent: 0,
        scripts: "graph/blast/cleanup",
      },
      note: skip
        ? "Docs-only: implementer only."
        : "Batched implementer + unified review.",
    };
  }
  // balanced
  const dual = [
    "public-api",
    "authentication-security",
    "database-migration",
    "high-blast",
  ].includes(changeClass);
  if (dual) {
    return {
      profile: p,
      minCalls: units * 3,
      breakdown: {
        implementer: units,
        spec_reviewer: units,
        code_reviewer: units,
        cleanup_agent: 0,
      },
      note: "High-risk class → dual review per execution unit.",
    };
  }
  return {
    profile: p,
    minCalls: units * 2,
    breakdown: {
      implementer: units,
      unified_reviewer: units,
      cleanup_agent: 0,
      scripts: "graph/blast/cleanup",
    },
    note: "Batched by execution unit; risk-based unified review.",
  };
}

const strict = estimate("strict");
const chosen = estimate(profile);
const savings = strict.minCalls - chosen.minCalls;

const out = {
  tasks,
  units,
  change_class: changeClass,
  recommended_profile: profile,
  estimated_calls: chosen.minCalls,
  strict_equivalent_calls: strict.minCalls,
  savings: Math.max(0, savings),
  breakdown: chosen.breakdown,
  reason: chosen.note,
  message: `Recommended profile: ${profile}\nEstimated calls: ${chosen.minCalls} instead of ${strict.minCalls} (strict)\nReason: ${chosen.note}`,
};

console.log(out.message);
console.log(JSON.stringify(out, null, 2));
