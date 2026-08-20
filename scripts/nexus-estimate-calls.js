#!/usr/bin/env node
/**
 * Estimate minimum agent calls for a Nexus V5 plan (fixed pipeline).
 *
 * Usage:
 *   node scripts/nexus-estimate-calls.js --tasks 5
 *   node scripts/nexus-estimate-calls.js --tasks 5 --fix-loops 1
 */
"use strict";

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  return args[i + 1] ?? def;
}

const tasks = Math.max(1, parseInt(flag("--tasks", "3"), 10) || 3);
const fixLoops = Math.max(0, parseInt(flag("--fix-loops", "0"), 10) || 0);

// V5: implementer + reviewer per task; each fix loop adds another pair
const perTask = 2;
const base = perTask * tasks;
const fixExtra = fixLoops * perTask;
const total = base + fixExtra;
const maxWithHeadroom = total + Math.max(2, tasks);

const out = {
  ok: true,
  workflow: "default",
  version: "5.0",
  tasks,
  fix_loops_assumed: fixLoops,
  calls: {
    implementer: tasks + fixLoops,
    reviewer: tasks + fixLoops,
    total,
    budget_ceiling: maxWithHeadroom,
  },
  formula: "tasks * (implementer + reviewer) + fix_loops * (implementer + reviewer)",
  notes: [
    "V5 has no fast/balanced/strict profile matrix.",
    "Every task always includes reviewer.",
    "Every implementer dispatch requires fresh pre-impact (script, not an agent call).",
  ],
};

console.log(JSON.stringify(out, null, 2));
