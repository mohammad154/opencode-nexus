#!/usr/bin/env node
/**
 * Nexus risk classifier CLI
 * Usage:
 *   node scripts/nexus-classify.js --files 2 --lines 40 --class documentation --focused
 *   node scripts/nexus-classify.js --input '{"filesChanged":1,"changeClass":"documentation","focusedValidation":true}'
 */
import fs from "fs";
import { classify, loadClassificationRules } from "./lib/classify.js";

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
    else if (a === "--input") out.inputPath = argv[++i];
    else if (a === "--json") out.jsonInline = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node scripts/nexus-classify.js [options]
  --files N --lines N --class NAME --focused --docs --security --public-api
  --profile fast|balanced|strict
  --input path.json | --json '{...}'`);
    process.exit(0);
  }

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

  const rules = loadClassificationRules();
  const result = classify(input, { rules });
  console.log(JSON.stringify(result, null, 2));
}

main();
