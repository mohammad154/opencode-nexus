#!/usr/bin/env node
/**
 * Compatibility shim — prefer scripts/nexus-estimate-calls.js
 * (This script counts agent calls, not monetary cost.)
 */
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(__dirname, "nexus-estimate-calls.js");

console.error(
  "[nexus-estimate-cost] Deprecated name — use nexus-estimate-calls.js (counts agent calls, not USD).",
);

const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
