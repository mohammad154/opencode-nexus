#!/usr/bin/env node
/**
 * Advisory project reconnaissance cache CLI (PR5.B).
 *
 * Usage:
 *   nexus project-profile [--json] [--refresh] [--no-write]
 *
 * The profile answers repository-level planning questions once: package
 * manager, ecosystem, verification commands, CI configuration, agent guides,
 * intent/ADR locations, memory locations, and base branch. It is reused while
 * the *content* of its declared source files is unchanged, so an unrelated code
 * commit does not force a rebuild.
 *
 * It is advisory: it cannot authorize a state transition, and it never contains
 * task-specific conclusions. The planner still reads the target implementation,
 * its tests, its callers, and any applicable design/ADR for the actual task.
 */
import { resolveProjectProfile } from "./lib/project-profile.js";

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    flags[key] = value === undefined ? true : value;
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const result = resolveProjectProfile(process.env.NEXUS_WORKTREE || process.cwd(), {
  refresh: flags.refresh === true || flags.refresh === "true",
  write: flags.write === "false" || flags["no-write"] === true ? false : true,
});

const payload = {
  ok: result.ok,
  advisory: true,
  authorizes: [],
  cache_hit: result.cache_hit,
  rebuilt: result.rebuilt,
  reason: result.reason,
  duration_ms: result.duration_ms,
  cache_path: result.path,
  cache_written: result.cache_written === true,
  profile: result.profile,
};

if (flags.json === true || flags.json === "true") {
  console.log(JSON.stringify(payload));
} else {
  console.log(JSON.stringify(payload, null, 2));
}
