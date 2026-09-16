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

function entryForFile(worktree, relative) {
  const absolute = path.join(worktree, ...relative.split("/"));
  const boundary = validateContainedPath(worktree, absolute, {
    allowMissing: false,
    rejectSymlinks: true,
  });
  if (!boundary.ok) {
    throw new Error(
      `workspace path ${relative} violates filesystem boundary (${boundary.reason})`,
    );
  }
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`workspace path ${relative} became a symlink during measurement`);
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
