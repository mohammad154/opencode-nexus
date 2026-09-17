#!/usr/bin/env node
/**
 * CLI: nexus review-package — build a deterministic reviewer briefing.
 *
 * Usage:
 *   nexus review-package --scope task|final [--run-id <id>] [--json] [--out-dir <dir>]
 */
import {
  buildReviewPackage,
} from "./lib/review-package.js";
import {
  latestActiveRunState,
  readRunState,
  writeRunState,
} from "./lib/migrate-artifacts.js";

function parseArgs(argv) {
  const out = {
    json: false,
    scope: "task",
    runId: null,
    worktree: process.env.NEXUS_WORKTREE || process.cwd(),
    outDir: null,
    base: null,
    head: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--scope") out.scope = argv[++i];
    else if (a === "--run-id") out.runId = argv[++i];
    else if (a === "--worktree") out.worktree = argv[++i];
    else if (a === "--out-dir") out.outDir = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--head") out.head = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: nexus review-package --scope task|final [--run-id <id>] [--base <sha>] [--head <sha>] [--out-dir <dir>] [--json]\n",
    );
    process.exit(0);
  }
  if (args.scope !== "task" && args.scope !== "final") {
    console.error("error: --scope must be task or final");
    process.exit(2);
  }

  let runState = null;
  try {
    if (args.runId) runState = readRunState(args.worktree, args.runId);
    else runState = latestActiveRunState(args.worktree);
  } catch {
    runState = null;
  }

  const meta = buildReviewPackage(args.worktree, {
    scope: args.scope,
    runState: runState || { run_id: args.runId || "adhoc" },
    baseCommit: args.base || undefined,
    headCommit: args.head || undefined,
    outDir: args.outDir || undefined,
  });

  // Persist the package pointer through the same locked/CAS state writer as
  // every other state mutation. A package that cannot be bound to run state
  // must not be reported as an authoritative handoff.
  if (runState?.run_id) {
    try {
      writeRunState(args.worktree, {
        ...runState,
        review_package: meta,
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            error: `review package was written but could not be bound to run state: ${String(error?.message || error)}`,
          },
          null,
          2,
        ),
      );
      process.exit(2);
    }
  }

  const text = JSON.stringify(meta, null, 2);
  process.stdout.write(text + "\n");
  process.exit(meta.ok ? 0 : 1);
}

main();
