#!/usr/bin/env node
/**
 * CLI: nexus impact — deterministic impact analysis.
 * Usage: node scripts/nexus-impact.js [--json] [--base HEAD] [--out path]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { analyzeImpact } from "./lib/impact/analyze.js";
import { boundaryError, validateContainedPath } from "./lib/filesystem-boundary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    json: false,
    base: "HEAD",
    outPath: null,
    worktree: process.cwd(),
    targets: [],
    phase: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--out") out.outPath = argv[++i];
    else if (a === "--worktree") out.worktree = argv[++i];
    else if (a === "--targets" || a === "--allowed-files" || a === "--files") {
      out.targets = String(argv[++i] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--phase") out.phase = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: nexus-impact [--json] [--base HEAD|auto|<ref>] [--targets <csv>] [--phase pre|post] [--out <path>] [--worktree <dir>]\n",
    );
    process.exit(0);
  }
  const report = analyzeImpact(args.worktree, {
    base: args.base,
    planned_targets: args.targets,
    phase: args.phase,
    post_impact: args.phase === "post",
  });
  const text = JSON.stringify(report, null, 2);
  const outPath =
    args.outPath ||
    path.join(args.worktree, ".opencode", "impact", "latest.json");
  // Containment is checked for every destination, including a caller-supplied
  // --out: the writer must never be able to place an artifact outside the
  // worktree, whoever asked for it.
  const assertContained = () => {
    const root = path.resolve(args.worktree);
    const boundary = validateContainedPath(root, path.resolve(root, outPath), {
      allowMissing: true,
      rejectSymlinks: true,
    });
    if (!boundary.ok) throw boundaryError("impact artifact path", boundary);
  };
  assertContained();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  assertContained();
  fs.writeFileSync(outPath, text + "\n");
  if (args.json) {
    process.stdout.write(text + "\n");
  }
  process.exit(report.ok ? 0 : 1);
}

main();
