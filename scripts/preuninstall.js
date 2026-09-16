#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isGlobalInstall, run as runCliPathCleanup } from "./ensure-cli-on-path.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A local dependency uninstall must not alter a user's global OpenCode setup.
// npm, pnpm, and bun expose enough install context for the shared detector to
// distinguish that case from removal of the globally installed CLI.
if (!isGlobalInstall(process.env, pkgRoot)) process.exit(0);

const cleanup = spawnSync("bash", [path.join(pkgRoot, "uninstall.sh")], {
  stdio: "inherit",
  env: process.env,
});
if (cleanup.error) {
  console.error(`opencode-nexus: pre-uninstall cleanup failed: ${cleanup.error.message}`);
  process.exit(1);
}
if (cleanup.signal) {
  console.error(`opencode-nexus: pre-uninstall cleanup terminated by ${cleanup.signal}`);
  process.exit(1);
}
if (cleanup.status !== 0) {
  process.exit(cleanup.status ?? 1);
}

runCliPathCleanup(["--remove"], { env: process.env });
