/**
 * Git worktree isolation for per-task implementers.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";

function run(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

export function worktreeRoot(repoRoot) {
  return path.join(repoRoot, ".opencode", "worktrees");
}

export function createTaskWorktree(repoRoot, taskId, { branch } = {}) {
  const safe = String(taskId).replace(/[^A-Za-z0-9._-]/g, "-");
  const dir = path.join(worktreeRoot(repoRoot), safe);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (fs.existsSync(dir)) {
    return { ok: true, path: dir, reused: true };
  }
  const branchName = branch || `nexus/${safe}`;
  const r = run(repoRoot, ["worktree", "add", "-b", branchName, dir, "HEAD"]);
  if (r.status !== 0) {
    // Branch may exist — try without -b
    const r2 = run(repoRoot, ["worktree", "add", dir, branchName]);
    if (r2.status !== 0) {
      return {
        ok: false,
        error: r2.stderr || r.stderr || "worktree add failed",
      };
    }
  }
  return { ok: true, path: dir, branch: branchName, reused: false };
}

export function removeTaskWorktree(repoRoot, taskId) {
  const safe = String(taskId).replace(/[^A-Za-z0-9._-]/g, "-");
  const dir = path.join(worktreeRoot(repoRoot), safe);
  if (!fs.existsSync(dir)) return { ok: true, removed: false };
  const r = run(repoRoot, ["worktree", "remove", "--force", dir]);
  return { ok: r.status === 0, stderr: r.stderr };
}

export function listTaskWorktrees(repoRoot) {
  const root = worktreeRoot(repoRoot);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map((name) => ({
    task_id: name,
    path: path.join(root, name),
  }));
}
