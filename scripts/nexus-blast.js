#!/usr/bin/env node
/**
 * Compatibility alias: `nexus blast` → Nexus Impact Engine.
 * Prefer: node scripts/nexus-impact.js
 */
import { spawnSync } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const impact = path.join(__dirname, "nexus-impact.js");
const args = process.argv.slice(2);
// Map legacy --files to impact (ignored by engine; git evidence is authoritative)
const forwarded = args.includes("--json") ? args : [...args, "--json"];
const r = spawnSync(process.execPath, [impact, ...forwarded], {
  stdio: "inherit",
  cwd: process.cwd(),
});
process.exit(r.status ?? 1);
