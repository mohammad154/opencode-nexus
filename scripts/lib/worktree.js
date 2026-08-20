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

export function createTaskWorktree(repoRoot, taskId, { branch, baseCommit } = {}) {
  const safe = String(taskId).replace(/[^A-Za-z0-9._-]/g, "-");
  const dir = path.join(worktreeRoot(repoRoot), safe);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (fs.existsSync(dir)) {
    const head = run(repoRoot, ["rev-parse", "HEAD"]);
    const wtHead = run(dir, ["rev-parse", "HEAD"]);
    const status = run(dir, ["status", "--porcelain"]);
    if (status.stdout && status.stdout.trim()) {
      return {
        ok: false,
        error: "existing worktree is dirty — remove or clean before reuse",
        path: dir,
      };
    }
    const headSha = (head.stdout || "").trim();
    const wtSha = (wtHead.stdout || "").trim();
    const base = baseCommit ? String(baseCommit).trim() : null;

    if (base && wtSha && wtSha !== base) {
      return {
        ok: false,
        error: `worktree HEAD ${wtSha} != expected base ${base}`,
        path: dir,
      };
    }
    if (headSha && wtSha && headSha !== wtSha) {
      return {
        ok: true,
        path: dir,
        reused: true,
        diverged: true,
        head: wtSha,
      };
    }
    return { ok: true, path: dir, reused: true, head: wtSha || null };
  }
  const branchName = branch || `nexus/${safe}`;
  const startPoint = (baseCommit ? String(baseCommit).trim() : "") || "HEAD";
  const r = run(repoRoot, ["worktree", "add", "-b", branchName, dir, startPoint]);
  if (r.status !== 0) {
    // Branch may exist — try without -b
    const r2 = run(repoRoot, ["worktree", "add", dir, branchName]);
    if (r2.status !== 0) {
      return {
        ok: false,
        error: (r2.stderr || r.stderr || "worktree add failed").trim(),
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
  return { ok: r.status === 0, removed: r.status === 0, stderr: r.stderr ? r.stderr.trim() : undefined };
}

export function listTaskWorktrees(repoRoot) {
  const root = worktreeRoot(repoRoot);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map((name) => ({
    task_id: name,
    path: path.join(root, name),
  }));
}
