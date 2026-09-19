/**
 * Git worktree isolation for per-task implementers.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import {
  boundaryError,
  validateContainedPath,
} from "./filesystem-boundary.js";

function run(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function cleanGitPath(value) {
  const text = String(value || "").trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

const SAFE_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TASK_ID_LENGTH = 128;
const MAX_CANONICAL_TASK_ID_LENGTH = 240;

function normalizePathIdentity(value, platform) {
  if (typeof value !== "string" || value.length === 0) return null;

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  let normalized;
  try {
    // realpathSync() supplies canonical paths at the call sites below. Keep
    // this normalization separate from containment validation so path identity
    // cannot weaken the existing filesystem boundary checks.
    normalized = pathApi.normalize(value);
  } catch {
    return null;
  }

  if (platform !== "win32") return normalized;

  // Git for Windows and Node can disagree about the namespace prefix. Treat
  // extended-length and UNC spellings as the same canonical identity before
  // applying the ordinary case/separator rules.
  normalized = normalized.replace(/^\\\\\?\\UNC\\/i, "\\\\");
  normalized = normalized.replace(/^\\\\\?\\/i, "");

  // Win32 accepts both separators and treats drive letters and path
  // components case-insensitively. path.win32.normalize() handles separator
  // and dot-segment normalization; lower-casing establishes the filesystem
  // identity, including the drive letter.
  normalized = normalized.replace(/\//g, "\\");
  const root = path.win32.parse(normalized).root;
  if (normalized.length > root.length) {
    normalized = normalized.replace(/[\\]+$/, "");
  }
  return normalized.toLowerCase();
}

/**
 * Compare canonical/real paths using the identity rules of a platform.
 *
 * The optional platform is injectable so Win32 identity can be tested from a
 * non-Windows host. Filesystem callers should retain their realpath and
 * containment checks before using this comparison.
 */
export function samePath(left, right, options = {}) {
  const platform =
    typeof options === "string"
      ? options
      : options?.platform || process.platform;
  const normalizedLeft = normalizePathIdentity(left, platform);
  const normalizedRight = normalizePathIdentity(right, platform);
  return (
    normalizedLeft !== null &&
    normalizedRight !== null &&
    normalizedLeft === normalizedRight
  );
}

export { normalizePathIdentity };

function resolveCommit(repoRoot, ref) {
  if (!ref) return null;
  const result = run(repoRoot, ["rev-parse", "--verify", `${String(ref).trim()}^{commit}`]);
  if (result.status !== 0) return null;
  return String(result.stdout || "").trim() || null;
}

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

function boundaryFailure(dir, result, label = "worktree path") {
  const error = boundaryError(label, result);
  return {
    ok: false,
    code: error.code,
    reason: error.reason,
    error: error.message,
    path: dir,
  };
}

function worktreeBoundary(repoRoot, dir) {
  return validateContainedPath(repoRoot, dir, {
    allowMissing: true,
    rejectSymlinks: true,
  });
}

function registeredWorktreePaths(repoRoot) {
  const result = run(repoRoot, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) return null;
  return String(result.stdout || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => cleanGitPath(line.slice("worktree ".length)))
    .filter(Boolean);
}

function existingGitWorktree(repoRoot, dir) {
  const boundary = worktreeBoundary(repoRoot, dir);
  if (!boundary.ok) return boundaryFailure(dir, boundary);

  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return {
      ok: false,
      code: "INVALID_WORKTREE",
      error: "existing worktree path is unavailable",
      path: dir,
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      code: "INVALID_WORKTREE",
      error: "existing path is not a directory git worktree",
      path: dir,
    };
  }

  const top = run(dir, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || !String(top.stdout || "").trim()) {
    return {
      ok: false,
      code: "INVALID_WORKTREE",
      error: "existing path is not a usable git worktree",
      path: dir,
    };
  }

  let realDir;
  let realTop;
  try {
    realDir = fs.realpathSync(dir);
    realTop = fs.realpathSync(cleanGitPath(top.stdout));
  } catch {
    return {
      ok: false,
      code: "INVALID_WORKTREE",
      error: "existing git worktree path cannot be canonicalized",
      path: dir,
    };
  }
  if (!samePath(realDir, realTop)) {
    return {
      ok: false,
      code: "INVALID_WORKTREE",
      error: "existing path is not the expected git worktree root",
      path: dir,
    };
  }

  const registered = registeredWorktreePaths(repoRoot);
  if (!registered) {
    return {
      ok: false,
      code: "INVALID_WORKTREE",
      error: "cannot verify registered git worktrees",
      path: dir,
    };
  }
  const registeredHere = registered.some((candidate) => {
    try {
      return samePath(fs.realpathSync(candidate), realDir);
    } catch {
      return false;
    }
  });
  if (!registeredHere) {
    return {
      ok: false,
      code: "INVALID_WORKTREE",
      error: "existing path is not a registered git worktree",
      path: dir,
    };
  }

  const inside = run(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || String(inside.stdout || "").trim() !== "true") {
    return {
      ok: false,
      code: "INVALID_WORKTREE",
      error: "existing path is not inside a git worktree",
      path: dir,
    };
  }

  const headSha = resolveCommit(dir, "HEAD");
  if (!headSha) {
    return {
      ok: false,
      code: "INVALID_WORKTREE",
      error: "existing git worktree has no readable HEAD",
      path: dir,
    };
  }
  return { ok: true, path: dir, head: headSha };
}

export function worktreeRoot(repoRoot) {
  return path.join(repoRoot, ".opencode", "worktrees");
}

export function createTaskWorktree(repoRoot, taskId, { branch, baseCommit } = {}) {
  const task = taskWorktree(repoRoot, taskId);
  if (!task.ok) return task;
  const { safe, path: dir } = task;
  const boundary = worktreeBoundary(repoRoot, dir);
  if (!boundary.ok) return boundaryFailure(dir, boundary);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (fs.existsSync(dir)) {
    const existing = existingGitWorktree(repoRoot, dir);
    if (!existing.ok) return existing;
    const status = run(dir, ["status", "--porcelain"]);
    if (status.status !== 0) {
      return {
        ok: false,
        code: "INVALID_WORKTREE",
        error: "existing worktree is not a usable git worktree",
        path: dir,
      };
    }
    if (status.stdout && status.stdout.trim()) {
      return {
        ok: false,
        error: "existing worktree is dirty — remove or clean before reuse",
        path: dir,
      };
    }
    const headSha = resolveCommit(repoRoot, "HEAD");
    const wtSha = existing.head;
    const base = baseCommit ? String(baseCommit).trim() : null;
    const expectedBase = base ? resolveCommit(repoRoot, base) : null;

    if (base && !expectedBase) {
      return {
        ok: false,
        code: "INVALID_WORKTREE",
        error: `cannot resolve expected base ${base}`,
        path: dir,
      };
    }

    if (expectedBase && wtSha && wtSha !== expectedBase) {
      return {
        ok: false,
        error: `worktree HEAD ${wtSha} != expected base ${expectedBase}`,
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
      const expected = resolveCommit(repoRoot, String(baseCommit).trim());
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
  const boundary = worktreeBoundary(repoRoot, dir);
  if (!boundary.ok) return { ...boundaryFailure(dir, boundary), removed: false };
  if (!fs.existsSync(dir)) return { ok: true, removed: false };
  const existing = existingGitWorktree(repoRoot, dir);
  if (!existing.ok) return { ...existing, removed: false };
  const r = run(repoRoot, ["worktree", "remove", "--force", dir]);
  return { ok: r.status === 0, removed: r.status === 0, stderr: r.stderr ? r.stderr.trim() : undefined };
}

export function listTaskWorktrees(repoRoot) {
  const root = worktreeRoot(repoRoot);
  const boundary = worktreeBoundary(repoRoot, root);
  if (!boundary.ok || !fs.existsSync(root)) return [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      task_id: entry.name,
      path: path.join(root, entry.name),
    }))
    .filter((entry) => existingGitWorktree(repoRoot, entry.path).ok);
}
