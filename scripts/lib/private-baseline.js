/**
 * Private git baseline for workspaces that are not already a repository.
 *
 * When `git rev-parse` shows this directory is not inside a work tree, Nexus
 * creates a repo, commits the current files with a repo-local identity, and
 * deletes that `.git` when the run finishes. An existing repository is never
 * rewritten and global git config is never touched. A content-hash snapshot
 * is used only when the git binary itself is missing.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateContainedPath } from "./filesystem-boundary.js";

export const BASELINE_COMMIT_MESSAGE = "nexus-baseline";
export const BASELINE_MARKER = path.join(".opencode", "private-baseline.json");
const LOCAL_NAME = "Nexus Baseline";
const LOCAL_EMAIL = "nexus-baseline@localhost";
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".opencode"]);

function run(gitBin, args, cwd, env) {
  return spawnSync(gitBin, args, {
    cwd,
    env,
    encoding: "utf8",
  });
}

function gitMissing(result) {
  return result?.error?.code === "ENOENT";
}

export function readPrivateBaseline(worktree) {
  if (!worktree) return null;
  try {
    const file = path.join(worktree, BASELINE_MARKER);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function rollbackCreatedGit(root) {
  const gitDir = path.join(root, ".git");
  try {
    const stat = fs.lstatSync(gitDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    fs.rmSync(gitDir, { recursive: true, force: false });
  } catch {
    // The caller still reports the baseline error. A leftover .git is not committed into.
  }
}

function writeMarker(worktree, marker) {
  const file = path.join(worktree, BASELINE_MARKER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function hashFile(file) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function walkFiles(root, relative, entries) {
  const absolute = path.join(root, relative);
  let children;
  try {
    children = fs.readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    throw new Error(`content-hash baseline cannot read ${relative || "."}: ${error.message}`);
  }
  for (const child of children) {
    if (SKIP_DIRECTORIES.has(child.name)) continue;
    const childRelative = relative ? `${relative}/${child.name}` : child.name;
    const childAbsolute = path.join(absolute, child.name);
    let stat;
    try {
      stat = fs.lstatSync(childAbsolute);
    } catch (error) {
      throw new Error(`content-hash baseline cannot stat ${childRelative}: ${error.message}`);
    }
    if (stat.isSymbolicLink()) {
      entries.push({ path: childRelative, type: "symlink", target: fs.readlinkSync(childAbsolute) });
      continue;
    }
    if (stat.isDirectory()) {
      walkFiles(root, childRelative, entries);
      continue;
    }
    if (!stat.isFile()) continue;
    entries.push({ path: childRelative, type: "file", sha256: hashFile(childAbsolute) });
  }
}

export function writeContentHashBaseline(worktree) {
  const entries = [];
  walkFiles(worktree, "", entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  const snapshot = {
    method: "content-hash",
    algorithm: "sha256",
    digest,
    commit: `content-hash:${digest.slice(0, 12)}`,
    files: entries,
    created_at: new Date().toISOString(),
  };
  const file = path.join(worktree, ".opencode", "baselines", "content-hash.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const marker = {
    created: false,
    existed_before: false,
    method: "content-hash",
    commit: snapshot.commit,
    digest,
    snapshot: path.join(".opencode", "baselines", "content-hash.json"),
    worktree: path.resolve(worktree),
  };
  writeMarker(worktree, marker);
  return {
    ok: true,
    created: false,
    existed_before: false,
    method: "content-hash",
    commit: snapshot.commit,
    digest,
    message:
      "Git is not available. Recorded a content-hash baseline at .opencode/baselines/content-hash.json instead of a commit.",
  };
}

/**
 * Create a private baseline when this directory is not already a git work tree.
 * Never runs `git config --global` and never commits into an existing repository.
 */
export function ensurePrivateBaseline(worktree, options = {}) {
  const root = path.resolve(worktree);
  const gitBin = options.gitBin || "git";
  const env = options.env || process.env;
  const version = run(gitBin, ["--version"], root, env);
  if (gitMissing(version)) return writeContentHashBaseline(root);

  const inside = run(gitBin, ["rev-parse", "--is-inside-work-tree"], root, env);
  const gitDir = path.join(root, ".git");
  let gitDirStat = null;
  try {
    gitDirStat = fs.lstatSync(gitDir);
  } catch {
    gitDirStat = null;
  }
  const inWorkTree = inside.status === 0 && String(inside.stdout || "").trim() === "true";
  if (inWorkTree || gitDirStat) {
    const head = run(gitBin, ["rev-parse", "HEAD"], root, env);
    return {
      ok: true,
      created: false,
      existed_before: true,
      method: "existing-git",
      head: head.status === 0 ? String(head.stdout || "").trim() || null : null,
      message: null,
    };
  }

  const init = run(gitBin, ["init"], root, env);
  if (init.status !== 0) {
    rollbackCreatedGit(root);
    return {
      ok: false,
      created: false,
      method: "git",
      message: `Private git baseline failed: git init exited ${init.status}. ${String(init.stderr || "").trim()}`,
    };
  }
  const localConfig = [
    ["config", "--local", "user.name", LOCAL_NAME],
    ["config", "--local", "user.email", LOCAL_EMAIL],
    ["config", "--local", "commit.gpgsign", "false"],
  ];
  for (const args of localConfig) {
    const configured = run(gitBin, args, root, env);
    if (configured.status !== 0) {
      rollbackCreatedGit(root);
      return {
        ok: false,
        created: true,
        existed_before: false,
        method: "git",
        message: `Private git baseline failed while setting a repo-local identity: ${args.join(" ")}`,
      };
    }
  }
  const added = run(gitBin, ["add", "-A"], root, env);
  if (added.status !== 0) {
    rollbackCreatedGit(root);
    return {
      ok: false,
      created: true,
      existed_before: false,
      method: "git",
      message: `Private git baseline failed: git add -A exited ${added.status}.`,
    };
  }
  let committed = run(gitBin, ["commit", "-m", BASELINE_COMMIT_MESSAGE], root, env);
  if (committed.status !== 0) {
    committed = run(
      gitBin,
      ["commit", "--allow-empty", "-m", BASELINE_COMMIT_MESSAGE],
      root,
      env,
    );
  }
  if (committed.status !== 0) {
    rollbackCreatedGit(root);
    return {
      ok: false,
      created: true,
      existed_before: false,
      method: "git",
      message: `Private git baseline failed: git commit exited ${committed.status}. ${String(committed.stderr || "").trim()}`,
    };
  }
  const head = run(gitBin, ["rev-parse", "HEAD"], root, env);
  const commit = head.status === 0 ? String(head.stdout || "").trim() : null;
  if (!commit) {
    rollbackCreatedGit(root);
    return {
      ok: false,
      created: true,
      existed_before: false,
      method: "git",
      message: "Private git baseline failed: git rev-parse HEAD returned no commit.",
    };
  }
  const marker = {
    created: true,
    existed_before: false,
    method: "git",
    commit,
    message: BASELINE_COMMIT_MESSAGE,
    worktree: root,
  };
  writeMarker(root, marker);
  return {
    ok: true,
    created: true,
    existed_before: false,
    method: "git",
    commit,
    message: `Private git baseline created at ${commit}. Nexus will remove this .git when the run finishes.`,
  };
}

function baselineCommitIsOurs(root, commit, gitBin, env) {
  const type = run(gitBin, ["cat-file", "-t", commit], root, env);
  if (type.status !== 0 || String(type.stdout || "").trim() !== "commit") return false;
  const roots = run(gitBin, ["rev-list", "--max-parents=0", "HEAD"], root, env);
  if (roots.status !== 0) return false;
  return String(roots.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(commit);
}

/**
 * Remove only a `.git` directory this process created for the private baseline.
 */
export function cleanupPrivateBaseline(worktree, options = {}) {
  const root = path.resolve(worktree);
  const marker = readPrivateBaseline(root);
  if (!marker || marker.created !== true || marker.existed_before !== false) {
    return { ok: true, removed: false, reason: "not-created-here" };
  }
  if (marker.method !== "git") {
    return { ok: true, removed: false, reason: "not-a-git-baseline" };
  }
  const env = options.env || process.env;
  const keep = String(env.NEXUS_KEEP_PRIVATE_BASELINE || "").trim();
  if (keep === "1" || keep === "true") {
    return { ok: true, removed: false, reason: "kept-by-env" };
  }
  const gitDir = path.join(root, ".git");
  const boundary = validateContainedPath(root, gitDir, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  if (!boundary.ok) {
    return { ok: false, removed: false, reason: boundary.reason };
  }
  let stat;
  try {
    stat = fs.lstatSync(gitDir);
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, removed: false, reason: "already-absent" };
    return { ok: false, removed: false, reason: error.message };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { ok: false, removed: false, reason: "refusing-non-directory-git" };
  }
  if (marker.worktree && path.resolve(marker.worktree) !== root) {
    return { ok: false, removed: false, reason: "worktree-mismatch" };
  }
  const gitBin = options.gitBin || "git";
  if (marker.commit && !baselineCommitIsOurs(root, marker.commit, gitBin, env)) {
    return { ok: false, removed: false, reason: "baseline-commit-missing" };
  }
  fs.rmSync(gitDir, { recursive: true, force: false });
  return { ok: true, removed: true, reason: "removed-private-baseline" };
}
