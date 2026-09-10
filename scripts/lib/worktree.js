/**
 * Git worktree isolation for per-task implementers.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";

function run(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

const SAFE_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TASK_ID_LENGTH = 128;
const MAX_CANONICAL_TASK_ID_LENGTH = 240;

/**
 * Turn an opaque task ID into one filesystem path segment without lossy
 * replacement. Safe IDs remain readable; other IDs are URI-encoded so that
 * distinct values cannot silently share a worktree directory.
 */
export function canonicalTaskId(taskId) {
  if (typeof taskId !== "string" || !taskId || taskId.length > MAX_TASK_ID_LENGTH) {
    return null;
  }
  const normalized = taskId.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === "." || part === "..") ||
    normalized.includes("\0")
  ) {
    return null;
  }
  if (SAFE_TASK_ID_RE.test(taskId)) return taskId;
  let encoded;
  try {
    encoded = `id-${encodeURIComponent(taskId)}`;
  } catch {
    return null;
  }
  return encoded.length <= MAX_CANONICAL_TASK_ID_LENGTH ? encoded : null;
}

function taskWorktree(repoRoot, taskId) {
  const safe = canonicalTaskId(taskId);
  if (!safe) {
    return {
      ok: false,
      error:
        `invalid task id "${String(taskId)}": must identify a non-traversal task`,
    };
  }
  return { ok: true, safe, path: path.join(worktreeRoot(repoRoot), safe) };
}

export function worktreeRoot(repoRoot) {
  return path.join(repoRoot, ".opencode", "worktrees");
}

export function createTaskWorktree(repoRoot, taskId, { branch, baseCommit } = {}) {
  const task = taskWorktree(repoRoot, taskId);
  if (!task.ok) return task;
  const { safe, path: dir } = task;
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
    // Branch may already exist. Never check it out in place of the requested
    // start point — attach a detached worktree at startPoint instead.
    const r2 = run(repoRoot, ["worktree", "add", "--detach", dir, startPoint]);
    if (r2.status !== 0) {
      return {
        ok: false,
        error: (r2.stderr || r.stderr || "worktree add failed").trim(),
      };
    }
    const wtSha = (run(dir, ["rev-parse", "HEAD"]).stdout || "").trim();
    if (baseCommit) {
      const expected = (run(repoRoot, ["rev-parse", String(baseCommit).trim()]).stdout || "").trim();
      if (expected && wtSha && wtSha !== expected) {
        run(repoRoot, ["worktree", "remove", "--force", dir]);
        return {
          ok: false,
          error: `worktree HEAD ${wtSha} != expected base ${expected}`,
          path: dir,
        };
      }
    }
    return {
      ok: true,
      path: dir,
      branch: branchName,
      reused: false,
      detached: true,
      head: wtSha || null,
    };
  }
  return { ok: true, path: dir, branch: branchName, reused: false };
}

export function removeTaskWorktree(repoRoot, taskId) {
  const task = taskWorktree(repoRoot, taskId);
  if (!task.ok) return { ...task, removed: false };
  const { path: dir } = task;
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
