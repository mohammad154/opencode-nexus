#!/usr/bin/env node
/**
 * Nexus risk classifier CLI — loads full workflow config (rules + reviewMatrix).
 */
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { classify, loadWorkflowConfig, reclassifyAfterBlast } from "./lib/classify.js";
import {
  collectGitDiffEvidence,
  mergeGitDiffEvidence,
} from "./lib/diff-evidence.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--files") out.files = Number(argv[++i]);
    else if (a === "--lines") out.lines = Number(argv[++i]);
    else if (a === "--class") out.changeClass = argv[++i];
    else if (a === "--profile") out.profileOverride = argv[++i];
    else if (a === "--focused") out.focusedValidation = true;
    else if (a === "--docs") out.documentationOnly = true;
    else if (a === "--security") out.securitySensitive = true;
    else if (a === "--public-api") out.publicApi = true;
    else if (a === "--migration") out.databaseMigration = true;
    else if (a === "--credential-handling") out.credentialHandling = true;
    else if (a === "--high-blast") out.blastRiskHigh = true;
    else if (a === "--blast") out.blastPath = argv[++i];
    else if (a === "--callers") out.directCallers = Number(argv[++i]);
    else if (a === "--diff" || a === "--from-diff") {
      out.diff = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) out.diffBase = argv[++i];
    }
    else if (a === "--no-diff") out.noDiff = true;
    else if (a === "--input") out.inputPath = argv[++i];
    else if (a === "--json") out.jsonInline = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else out._.push(a);
  }
  return out;
}

const USAGE = `Usage: node scripts/nexus-classify.js [options]
  --files N --lines N --class NAME --focused --docs --security --public-api
  --migration --credential-handling --high-blast
  --diff [BASE] | --from-diff [BASE]
  --no-diff (compatibility input; never authorizes direct execution)
  --profile fast|balanced|strict
  --blast path.json (post-blast reclassification)
  --callers N
  --input path.json | --json '{...}'
Note: --class public-api|authentication-security|database-migration
      alone triggers hard strict + dual review. HIGH blast escalates review;
      execution profile is re-scored from semantic + impact evidence.`;

export function classifyFromArgs(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) return { help: true };

  let input = {};
  if (args.inputPath) {
    input = JSON.parse(fs.readFileSync(args.inputPath, "utf8"));
  } else if (args.jsonInline) {
    input = JSON.parse(args.jsonInline);
  }
  if (args.files != null) input.filesChanged = args.files;
  if (args.lines != null) input.estimatedLines = args.lines;
  if (args.changeClass) input.changeClass = args.changeClass;
  if (args.profileOverride) input.profileOverride = args.profileOverride;
  if (args.focusedValidation) input.focusedValidation = true;
  if (args.documentationOnly) input.documentationOnly = true;
  if (args.securitySensitive) input.securitySensitive = true;
  if (args.publicApi) input.publicApi = true;
  if (args.databaseMigration) input.databaseMigration = true;
  if (args.credentialHandling) input.credentialHandling = true;
  if (args.blastRiskHigh) input.blastRiskHigh = true;

  // Collect the current diff by default. --no-diff is retained only for
  // compatibility with callers that cannot provide a repository; it cannot
  // authorize direct execution.
  if (!args.noDiff) {
    const diffEvidence = collectGitDiffEvidence({
      cwd,
      base: args.diff ? args.diffBase : undefined,
    });
    input = mergeGitDiffEvidence(input, diffEvidence);
    input.diff_verified = diffEvidence.diff_available === true;
  }

  const workflowConfig = loadWorkflowConfig();
  if (args.directCallers != null && Number.isFinite(args.directCallers)) {
    input.directCallers = args.directCallers;
  }
  if (args.blastPath) {
    const blast = JSON.parse(fs.readFileSync(args.blastPath, "utf8"));
    const previous = classify(input, { workflowConfig });
    return reclassifyAfterBlast(previous, blast.report || blast, { workflowConfig });
  }
  return classify(input, { workflowConfig });
}

export function main(argv = process.argv.slice(2)) {
  const result = classifyFromArgs(argv);
  if (result.help) {
    console.log(USAGE);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error.message || error) }));
    process.exit(2);
  }
}
