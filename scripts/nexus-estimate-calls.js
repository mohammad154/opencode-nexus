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

// V5: implementer + task reviewer per task; +1 final whole-branch reviewer;
// each fix loop adds another implementer+reviewer pair
const perTask = 2;
const finalReviewer = 1;
const base = perTask * tasks + finalReviewer;
const fixExtra = fixLoops * perTask;
const total = base + fixExtra;
const maxWithHeadroom = total + Math.max(2, tasks);

const out = {
  ok: true,
  workflow: "default",
  version: "5.1",
  tasks,
  fix_loops_assumed: fixLoops,
  calls: {
    implementer: tasks + fixLoops,
    reviewer: tasks + fixLoops + finalReviewer,
    total,
    budget_ceiling: maxWithHeadroom,
  },
  formula:
    "tasks * (implementer + reviewer) + 1 final reviewer + fix_loops * (implementer + reviewer)",
  notes: [
    "V5 has no fast/balanced/strict profile matrix.",
    "Every task includes a task-scoped reviewer; every run adds one final whole-branch reviewer.",
    "Every implementer dispatch requires fresh pre-impact (script, not an agent call).",
    "Generate review packages with: nexus review-package --scope task|final",
  ],
};

console.log(JSON.stringify(out, null, 2));
