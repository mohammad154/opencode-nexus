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
  "[nexus-estimate-cost] Deprecated compatibility name — use nexus-estimate-calls.js for agent-call estimates. Monetary cost is unavailable unless the host supplies pricing.",
);

const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
