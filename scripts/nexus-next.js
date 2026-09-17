#!/usr/bin/env node
/**
 * Print the deterministic next orchestrator action for the active (or specified) run.
 *
 * Usage:
 *   node scripts/nexus-next.js
 *   node scripts/nexus-next.js --run-id <id>
 *   node scripts/nexus-next.js --json
 */
import {
  resolveNextAction,
  formatNextActionInjection,
} from "./lib/next-action.js";
import {
  latestActiveRunState,
  readRunState,
} from "./lib/migrate-artifacts.js";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

const worktree = process.env.NEXUS_WORKTREE || process.cwd();
const asJson = args.includes("--json");

let state = null;
try {
  const runId = flag("--run-id");
  if (runId && runId !== true) {
    state = readRunState(worktree, String(runId));
  } else {
    state = latestActiveRunState(worktree);
  }
} catch (err) {
  console.error(
    JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2),
  );
  process.exit(2);
}

const next = resolveNextAction(state, { worktree });
if (asJson) {
  console.log(JSON.stringify({ ok: next.ok !== false, next }, null, 2));
} else {
  console.log(formatNextActionInjection(next));
}
process.exit(next.ok === false ? 2 : 0);
