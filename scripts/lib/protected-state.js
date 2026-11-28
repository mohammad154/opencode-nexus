/**
 * Run-scoped control records that live outside the project directory.
 *
 * Subagent timeout records and the private-baseline marker decide whether a
 * review or a `.git` deletion may happen, so they must not sit where project
 * code can rewrite them. Test suites, build scripts, and implementer shell
 * commands all run inside the worktree; this directory does not. It is keyed by
 * the canonical worktree path and the run id, so one project cannot read or
 * overwrite another project's records.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATE_DIR_NAME = "nexus-control";

export function protectedStateRoot(env = process.env) {
  const override = String(env?.NEXUS_STATE_DIR || "").trim();
  if (override) return path.resolve(override);
  const xdg = String(env?.XDG_STATE_HOME || "").trim();
  const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), ".local", "state");
  return path.join(base, STATE_DIR_NAME);
}

function canonicalWorktree(worktree) {
  const resolved = path.resolve(worktree);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function protectedRunDir(worktree, runId, env = process.env) {
  if (!worktree || typeof runId !== "string" || !SAFE_RUN_ID.test(runId) || runId.includes("..")) {
    return null;
  }
  const canonical = canonicalWorktree(worktree);
  const keyed =
    process.platform === "win32" || process.platform === "darwin" ? canonical.toLowerCase() : canonical;
  const digest = createHash("sha256").update(keyed).digest("hex").slice(0, 32);
  return path.join(protectedStateRoot(env), "worktrees", digest, "runs", runId);
}
