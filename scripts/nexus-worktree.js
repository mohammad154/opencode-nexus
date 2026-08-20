#!/usr/bin/env node
/**
 * Nexus task worktree management CLI
 *
 * Usage:
 *   nexus worktree create --task <id> [--branch <name>] [--base <sha>] [--run-id <run>]
 *   nexus worktree list
 *   nexus worktree remove --task <id>
 */
import {
  createTaskWorktree,
  removeTaskWorktree,
  listTaskWorktrees,
} from "./lib/worktree.js";

const USAGE = `Usage: nexus worktree <subcommand> [flags]

Subcommands:
  create    Create or reuse an isolated worktree for a task
            Flags: --task <id> [--branch <name>] [--base <sha>] [--run-id <run>]
  list      List all active task worktrees
  remove    Remove a task worktree
            Flags: --task <id>
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out.flags[key] = true;
    else {
      out.flags[key] = next;
      i++;
    }
  }
  return out;
}

function getRepoRoot() {
  return process.env.NEXUS_WORKTREE || process.cwd();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const subcmd = args._[0];
  const flags = args.flags;
  const repoRoot = getRepoRoot();

  if (!subcmd || subcmd === "help" || subcmd === "--help" || subcmd === "-h") {
    console.log(USAGE.trimEnd());
    process.exit(subcmd ? 0 : 2);
  }

  switch (subcmd) {
    case "create": {
      const task = flags.task || flags["task-id"];
      if (!task) {
        console.error(JSON.stringify({ ok: false, error: "--task required" }, null, 2));
        process.exit(2);
      }
      const branch = flags.branch ? String(flags.branch) : undefined;
      const baseCommit = flags.base || flags["base-commit"] ? String(flags.base || flags["base-commit"]) : undefined;
      const result = createTaskWorktree(repoRoot, task, { branch, baseCommit });
      if (!result.ok) {
        console.error(JSON.stringify(result, null, 2));
        process.exit(2);
      }
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "list": {
      const worktrees = listTaskWorktrees(repoRoot);
      console.log(JSON.stringify({ ok: true, worktrees }, null, 2));
      break;
    }
    case "remove": {
      const task = flags.task || flags["task-id"];
      if (!task) {
        console.error(JSON.stringify({ ok: false, error: "--task required" }, null, 2));
        process.exit(2);
      }
      const result = removeTaskWorktree(repoRoot, task);
      if (!result.ok) {
        console.error(JSON.stringify({ ok: false, task, ...result }, null, 2));
        process.exit(2);
      }
      console.log(JSON.stringify({ ok: true, task, ...result }, null, 2));
      break;
    }
    default: {
      console.error(USAGE.trimEnd() + `\n\nError: unknown subcommand: ${subcmd}`);
      process.exit(2);
    }
  }
}

main();
