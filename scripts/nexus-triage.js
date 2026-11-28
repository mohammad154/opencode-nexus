#!/usr/bin/env node
/**
 * Classify a task onto the direct fast path or the standard pipeline.
 *
 *   nexus triage [--json '{}'] [--files N] [--lines N] [--risk LEVEL]
 */
import fs from "node:fs";
import { probeWorkspace, selectFastPath } from "./lib/fast-path.js";

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      index += 1;
    }
  }
  return flags;
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(2);
}

const flags = parseArgs(process.argv.slice(2));
if (flags.help === true) {
  console.log(
    "Usage: nexus triage [--json '{}'] [--files N] [--lines N] [--class NAME] [--risk LEVEL]\n",
  );
  process.exit(0);
}

let input = {};
if (flags.json && flags.json !== true) {
  try {
    input = JSON.parse(flags.json);
  } catch (error) {
    fail(`invalid --json: ${error.message}`);
  }
}
if (flags.input && flags.input !== true) {
  try {
    input = { ...JSON.parse(fs.readFileSync(flags.input, "utf8")), ...input };
  } catch (error) {
    fail(`invalid --input: ${error.message}`);
  }
}
if (flags.files != null && flags.files !== true) input.files_changed = Number(flags.files);
if (flags.lines != null && flags.lines !== true) input.estimated_lines = Number(flags.lines);
if (flags.class && flags.class !== true) input.change_class = flags.class;
if (flags.risk && flags.risk !== true) input.risk = flags.risk;
if (flags.objective && flags.objective !== true) input.objective = flags.objective;

const workspace = probeWorkspace(process.env.NEXUS_WORKTREE || process.cwd());
const decision = selectFastPath(input, { workspace });
console.log(JSON.stringify({ ok: true, workspace, fast_path: decision }, null, 2));
