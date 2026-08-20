#!/usr/bin/env node
/**
 * Print the deterministic next orchestrator action for the active (or specified) run.
 *
 * Usage:
 *   node scripts/nexus-next.js
 *   node scripts/nexus-next.js --run-id <id>
 *   node scripts/nexus-next.js --json
 */
import fs from "fs";
import path from "path";
import {
  resolveNextAction,
  formatNextActionInjection,
} from "./lib/next-action.js";
import { latestRunState, readRunState } from "./lib/migrate-artifacts.js";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1] ?? true;
}

const worktree = process.env.NEXUS_WORKTREE || process.cwd();
const asJson = args.includes("--json");
const runId = flag("--run-id");

let state = null;
try {
  if (runId && runId !== true) {
    state = readRunState(worktree, String(runId));
  } else {
    state = latestRunState(worktree);
    if (state && ["COMPLETED", "FAILED"].includes(state.state)) {
      // Prefer a non-terminal run if latest is terminal
      const runsRoot = path.join(worktree, ".opencode", "runs");
      if (fs.existsSync(runsRoot)) {
        const dirs = fs.readdirSync(runsRoot);
        let best = null;
        for (const id of dirs) {
          try {
            const s = readRunState(worktree, id);
            if (!s || ["COMPLETED", "FAILED"].includes(s.state)) continue;
            if (!best || (s.updated_at || "") > (best.updated_at || "")) best = s;
          } catch {
            /* skip */
          }
        }
        if (best) state = best;
      }
    }
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
