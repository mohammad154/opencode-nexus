/**
 * Repository source-state measurement used by authorization gates.
 *
 * Runtime/build artifacts are intentionally excluded from this identity. The
 * result is still fail-closed when Git cannot provide an authoritative file
 * inventory or status.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DEFAULT_IGNORE_PATTERNS, isIgnoredPath } from "./path-filter.js";
import { validateContainedPath } from "./filesystem-boundary.js";

function runGit(worktree, args) {
  try {
    const result = spawnSync("git", args, {
      cwd: worktree,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      ok: result.status === 0,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
      status: result.status,
      error: result.error || null,
    };
  } catch (error) {
    return { ok: false, stdout: "", stderr: "", status: null, error };
  }
}

function normalizeRepoPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function isRuntimePath(file) {
  const normalized = normalizeRepoPath(file);
  if (!normalized) return true;
  return (
    isIgnoredPath(normalized, DEFAULT_IGNORE_PATTERNS) ||
    normalized === ".opencode" ||
    normalized.startsWith(".opencode/") ||
    normalized === "graphify-out" ||
    normalized.startsWith("graphify-out/") ||
    normalized === ".antigravity" ||
    normalized.startsWith(".antigravity/")
  );
}

function addPath(set, value) {
  const normalized = normalizeRepoPath(value);
  if (normalized && !isRuntimePath(normalized)) set.add(normalized);
}

function parseStatusPaths(stdout) {
  const paths = new Set();
  const tokens = String(stdout || "").split("\0").filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) continue;
    const status = token.slice(0, 2);
    addPath(paths, token.slice(3));
    if (status.includes("R") || status.includes("C")) {
      addPath(paths, tokens[index + 1]);
      index += 1;
    }
  }
  return paths;
}

function pathInventory(worktree, statusPaths) {
  const listed = runGit(worktree, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (!listed.ok) return listed;
  const paths = new Set(statusPaths);
  for (const file of listed.stdout.split("\0")) addPath(paths, file);
  return { ok: true, paths: [...paths].sort() };
}

function runtimeRelativePath(worktree, absolute) {
  const relative = path.relative(worktree, absolute).replace(/\\/g, "/");
  return relative || ".";
}

/**
 * Runtime state is deliberately stricter than source inventory. Runtime
 * paths may be read or written by Nexus, so an external or dangling symlink
 * must fail closed instead of being treated as an ignored artifact.
 */
function assertRuntimeTreeSafe(worktree) {
  const runtimeRoot = path.join(worktree, ".opencode");
  let rootStat;
  try {
    rootStat = fs.lstatSync(runtimeRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error(
      `runtime path .opencode is unavailable (${error?.message || error})`,
    );
  }

  const rootBoundary = validateContainedPath(worktree, runtimeRoot, {
    allowMissing: false,
    rejectSymlinks: true,
  });
  if (!rootBoundary.ok) {
    throw new Error(
      `runtime path .opencode violates filesystem boundary (${rootBoundary.reason})`,
    );
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error("runtime path .opencode is a symlink");
  }
  if (!rootStat.isDirectory()) {
    throw new Error("runtime path .opencode is not a directory");
  }

  const pending = [runtimeRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        `runtime path ${runtimeRelativePath(worktree, current)} is unreadable (${error?.message || error})`,
      );
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = runtimeRelativePath(worktree, absolute);
      const boundary = validateContainedPath(worktree, absolute, {
        allowMissing: false,
        rejectSymlinks: true,
      });
      if (!boundary.ok) {
        throw new Error(
          `runtime path ${relative} violates filesystem boundary (${boundary.reason})`,
        );
      }
      let stat;
      try {
        stat = fs.lstatSync(absolute);
      } catch (error) {
        throw new Error(
          `runtime path ${relative} is unavailable (${error?.message || error})`,
        );
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`runtime path ${relative} is a symlink`);
      }
      if (stat.isDirectory()) pending.push(absolute);
    }
  }
}

function entryForFile(worktree, relative) {
  const absolute = path.join(worktree, ...relative.split("/"));
  // Validate only the parent first. The final source entry may itself be a
  // symlink; resolving it here would reject safe repository links and would
  // also read through an external target during measurement.
  const parentBoundary = validateContainedPath(worktree, path.dirname(absolute), {
    allowMissing: false,
    rejectSymlinks: true,
  });
  if (!parentBoundary.ok) {
    throw new Error(
      `workspace path ${relative} violates filesystem boundary (${parentBoundary.reason})`,
    );
  }
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      // Source links are identity metadata, not content to dereference. This
      // intentionally accepts internal, external-target, and dangling links:
      // lstat/readlink cannot escape the measurement or fail because a target
      // is absent. Any later consumer that follows the target must validate it
      // independently against its own containment policy.
      return `${relative}\0symlink\0${stat.mode}\0${fs.readlinkSync(absolute)}`;
    }
    const boundary = validateContainedPath(worktree, absolute, {
      allowMissing: false,
      rejectSymlinks: true,
    });
    if (!boundary.ok) {
      throw new Error(
        `workspace path ${relative} violates filesystem boundary (${boundary.reason})`,
      );
    }
    if (!stat.isFile()) {
      return `${relative}\0mode\0${stat.mode}`;
    }
    const digest = createHash("sha256")
      .update(fs.readFileSync(absolute))
      .digest("hex");
    return `${relative}\0file\0${stat.mode}\0${digest}`;
  } catch (error) {
    if (error?.code === "ENOENT") return `${relative}\0missing`;
    throw error;
  }
}

/**
 * Measure current non-runtime repository state.
 *
 * @returns {{available:boolean, clean?:boolean, dirty_paths?:string[], workspace_digest?:string, content_digest?:string, checked_at?:string, error?:string}}
 */
export function inspectWorkspace(worktree) {
  const root =
    typeof worktree === "string" && worktree.trim()
      ? path.resolve(worktree)
      : null;
  if (!root) {
    return {
      available: false,
      error: "workspace path is required for source-state measurement",
    };
  }

  const rootBoundary = validateContainedPath(root, root, {
    allowMissing: false,
    rejectSymlinks: true,
  });
  if (!rootBoundary.ok) {
    return {
      available: false,
      error: `workspace path violates filesystem boundary (${rootBoundary.reason})`,
    };
  }

  try {
    assertRuntimeTreeSafe(root);
  } catch (error) {
    return {
      available: false,
      error: `runtime path measurement failed: ${error?.message || error}`,
    };
  }

  const status = runGit(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
  ]);
  if (!status.ok) {
    return {
      available: false,
      error: `git status unavailable: ${status.error?.message || status.stderr || "unknown error"}`,
    };
  }

  const statusPaths = parseStatusPaths(status.stdout);
  const inventory = pathInventory(root, statusPaths);
  if (!inventory.ok) {
    return {
      available: false,
      error: `git file inventory unavailable: ${inventory.error?.message || inventory.stderr || "unknown error"}`,
    };
  }

  let entries;
  try {
    entries = inventory.paths.map((relative) => entryForFile(root, relative));
  } catch (error) {
    return {
      available: false,
      error: `workspace file measurement failed: ${error?.message || error}`,
    };
  }
  const digest = `sha256:${createHash("sha256")
    .update(entries.join("\n"))
    .digest("hex")}`;
  const dirtyPaths = [...statusPaths].sort();
  const checkedAt = new Date().toISOString();
  return {
    available: true,
    clean: dirtyPaths.length === 0,
    dirty_paths: dirtyPaths,
    workspace_digest: digest,
    // Keep the content alias explicit for consumers that use that vocabulary.
    content_digest: digest,
    checked_at: checkedAt,
  };
}

export { isRuntimePath };
