/**
 * Private git baseline for workspaces that are not already a repository.
 *
 * Nexus creates the repo itself. It never asks the orchestrator to run
 * git init/add/commit, never writes global git config, and never commits
 * into or edits an existing repository. The marker lives in the protected run
 * directory outside the project (protected-state.js), so project code and agent
 * shell commands cannot forge it. `.git` is removed only when this run created
 * it and every commit after the baseline is one of this run's recorded
 * direct-edit seals, with no extra branches, tags, or worktrees. A content-hash
 * snapshot is used only when the git binary itself is missing.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateContainedPath } from "./filesystem-boundary.js";
import { protectedRunDir } from "./protected-state.js";
import {
  changedPathsFromEntries,
  normalizeAllowedFiles,
  outOfScopePaths,
  parseStatusZ,
  SCOPE_DRIFT_HINT,
} from "./direct-scope.js";

export const BASELINE_COMMIT_MESSAGE = "nexus-baseline";
export const DIRECT_EDIT_COMMIT_MESSAGE = "nexus-direct-edit";
const LOCAL_NAME = "Nexus Baseline";
const LOCAL_EMAIL = "nexus-baseline@localhost";
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".opencode",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
]);

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

export function baselineMarkerPath(worktree, runId) {
  const dir = protectedRunDir(worktree, runId);
  return dir ? path.join(dir, "private-baseline.json") : null;
}

export function readPrivateBaseline(worktree, runId) {
  const file = baselineMarkerPath(worktree, runId);
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    if (data.run_id && data.run_id !== runId) return null;
    return data;
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
    // The caller still reports the baseline error.
  }
}

function writeMarker(worktree, runId, marker) {
  const file = baselineMarkerPath(worktree, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return file;
}

function removeContentHashSnapshot(worktree, runId, marker) {
  const dir = protectedRunDir(worktree, runId);
  if (!dir || typeof marker?.snapshot !== "string") return;
  const file = path.resolve(worktree, marker.snapshot);
  if (path.dirname(file) !== dir) return;
  fs.rmSync(file, { force: true });
}

function removeMarker(worktree, runId) {
  const file = baselineMarkerPath(worktree, runId);
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
    fs.rmdirSync(path.dirname(file));
  } catch {
    // A missing marker or a run directory that still holds timeout records is kept.
  }
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

function snapshotEntries(worktree) {
  const entries = [];
  walkFiles(worktree, "", entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return { entries, digest };
}

export function writeContentHashBaseline(worktree, options = {}) {
  const runId = options.runId || null;
  if (!runId) {
    return {
      ok: false,
      created: false,
      method: "content-hash",
      message: "Content-hash baseline requires a run_id.",
    };
  }
  const runDir = protectedRunDir(worktree, runId);
  if (!runDir) {
    return {
      ok: false,
      created: false,
      method: "content-hash",
      message: "Content-hash baseline requires a valid run_id.",
    };
  }
  const { entries, digest } = snapshotEntries(worktree);
  const snapshotFile = path.join(runDir, "content-hash.json");
  const snapshot = {
    method: "content-hash",
    algorithm: "sha256",
    run_id: runId,
    digest,
    commit: `content-hash:${digest.slice(0, 12)}`,
    files: entries,
    created_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
  fs.writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const marker = {
    created: false,
    existed_before: false,
    method: "content-hash",
    run_id: runId,
    commit: snapshot.commit,
    digest,
    snapshot: snapshotFile,
    worktree: path.resolve(worktree),
  };
  writeMarker(worktree, runId, marker);
  return {
    ok: true,
    created: false,
    existed_before: false,
    method: "content-hash",
    run_id: runId,
    commit: snapshot.commit,
    digest,
    message:
      "Git is not available. Recorded a content-hash baseline in the protected run directory instead of a commit.",
  };
}

/**
 * Recompute the content-hash snapshot and report paths that differ from it.
 */
export function diffContentHashBaseline(worktree, marker) {
  const { entries, digest } = snapshotEntries(worktree);
  let baselineEntries = [];
  if (marker?.snapshot) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.resolve(worktree, marker.snapshot), "utf8"));
      baselineEntries = Array.isArray(saved?.files) ? saved.files : [];
    } catch {
      baselineEntries = [];
    }
  }
  const before = new Map(
    baselineEntries.map((entry) => [entry.path, `${entry.type}:${entry.sha256 || entry.target || ""}`]),
  );
  const after = new Map(
    entries.map((entry) => [entry.path, `${entry.type}:${entry.sha256 || entry.target || ""}`]),
  );
  const dirty = [];
  for (const [relative, identity] of after) {
    if (before.get(relative) !== identity) dirty.push(relative);
  }
  for (const relative of before.keys()) {
    if (!after.has(relative)) dirty.push(relative);
  }
  dirty.sort();
  const workspaceDigest = `sha256:${digest}`;
  return {
    available: true,
    clean: dirty.length === 0,
    dirty_paths: dirty,
    workspace_digest: workspaceDigest,
    content_digest: workspaceDigest,
    checked_at: new Date().toISOString(),
    source: "content-hash",
  };
}

/**
 * Run `fn` with a fresh empty hooks directory under the OS temp dir, so no
 * repository or global hook can run and nothing is left inside `.git`.
 */
function withEmptyHooks(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-no-hooks-"));
  try {
    return fn(dir.replace(/\\/g, "/"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function commitCommand(hooksPath, { message, empty = false } = {}) {
  return [
    "-c",
    `core.hooksPath=${hooksPath}`,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.autocrlf=false",
    "-c",
    `user.name=${LOCAL_NAME}`,
    "-c",
    `user.email=${LOCAL_EMAIL}`,
    "commit",
    "--no-verify",
    "-q",
    ...(empty ? ["--allow-empty"] : []),
    "-m",
    message,
  ];
}

function ensureExclude(root, extraPaths = []) {
  const excludeFile = path.join(root, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  const lines = [
    ".opencode/",
    "node_modules/",
    ".venv/",
    "venv/",
    "__pycache__/",
    ".cache/",
    "*.bin",
    ...extraPaths,
  ];
  const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
  const have = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = lines.filter((line) => !have.has(line));
  if (missing.length === 0 && existing) return;
  const prefix = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
  fs.writeFileSync(excludeFile, `${prefix}${missing.join("\n")}\n`, "utf8");
}

function collectLargeFiles(root, maxBytes) {
  const skipped = [];
  function walk(relative) {
    const absolute = path.join(root, relative);
    let children;
    try {
      children = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (SKIP_DIRECTORIES.has(child.name)) continue;
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const childAbsolute = path.join(absolute, child.name);
      let stat;
      try {
        stat = fs.lstatSync(childAbsolute);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(childRelative);
        continue;
      }
      if (stat.isFile() && stat.size > maxBytes) skipped.push(childRelative.replace(/\\/g, "/"));
    }
  }
  walk("");
  return skipped;
}

function sameWorktree(left, right) {
  if (!left || !right) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function gitDirIdentity(root) {
  const stat = fs.lstatSync(path.join(root, ".git"));
  return {
    ino: stat.ino,
    dev: stat.dev,
    ctimeMs: stat.ctimeMs,
  };
}

function gitDirMatches(root, recorded) {
  if (!recorded || typeof recorded !== "object") return false;
  let stat;
  try {
    stat = fs.lstatSync(path.join(root, ".git"));
  } catch {
    return false;
  }
  if (stat.ino && recorded.ino) {
    return stat.ino === recorded.ino && stat.dev === recorded.dev;
  }
  return stat.ctimeMs === recorded.ctimeMs;
}

/**
 * Create a private baseline when this directory is not already a git work tree.
 * Never runs `git config --global` and never commits into an existing repository.
 */
export function ensurePrivateBaseline(worktree, options = {}) {
  const root = path.resolve(worktree);
  const runId = options.runId || null;
  const gitBin = options.gitBin || "git";
  const env = options.env || process.env;
  const maxFileBytes = Number(options.maxFileBytes) > 0 ? Number(options.maxFileBytes) : DEFAULT_MAX_FILE_BYTES;
  const version = run(gitBin, ["--version"], root, env);
  if (gitMissing(version)) return writeContentHashBaseline(root, { runId });

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
      run_id: runId,
      head: head.status === 0 ? String(head.stdout || "").trim() || null : null,
      message: null,
    };
  }
  if (!runId || !baselineMarkerPath(root, runId)) {
    return {
      ok: false,
      created: false,
      method: "git",
      message: "Private git baseline requires a valid run_id.",
    };
  }

  const template = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-template-"));
  try {
    const init = run(gitBin, ["init", `--template=${template}`], root, env);
    if (init.status !== 0) {
      rollbackCreatedGit(root);
      return {
        ok: false,
        created: false,
        method: "git",
        message: `Private git baseline failed: git init exited ${init.status}. ${String(init.stderr || "").trim()}`,
      };
    }
  } finally {
    fs.rmSync(template, { recursive: true, force: true });
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

  const skipped = collectLargeFiles(root, maxFileBytes);
  try {
    ensureExclude(root, skipped);
  } catch (error) {
    rollbackCreatedGit(root);
    return {
      ok: false,
      created: true,
      existed_before: false,
      method: "git",
      message: `Private git baseline failed while writing .git/info/exclude: ${error.message}`,
    };
  }
  const added = run(gitBin, ["-c", "core.autocrlf=false", "add", "-A"], root, env);
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
  let committed = withEmptyHooks((hooksPath) =>
    run(gitBin, commitCommand(hooksPath, { message: BASELINE_COMMIT_MESSAGE }), root, env),
  );
  if (committed.status !== 0) {
    committed = withEmptyHooks((hooksPath) =>
      run(gitBin, commitCommand(hooksPath, { message: BASELINE_COMMIT_MESSAGE, empty: true }), root, env),
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
  let identity;
  try {
    identity = gitDirIdentity(root);
  } catch (error) {
    rollbackCreatedGit(root);
    return {
      ok: false,
      created: true,
      existed_before: false,
      method: "git",
      message: `Private git baseline failed while recording .git identity: ${error.message}`,
    };
  }
  const marker = {
    created: true,
    existed_before: false,
    method: "git",
    run_id: runId,
    commit,
    message: BASELINE_COMMIT_MESSAGE,
    worktree: root,
    git_dir: identity,
    seal_commits: [],
    skipped,
  };
  try {
    writeMarker(root, runId, marker);
  } catch (error) {
    rollbackCreatedGit(root);
    return {
      ok: false,
      created: true,
      existed_before: false,
      method: "git",
      message: `Private git baseline failed while writing the protected marker: ${error.message}`,
    };
  }
  const skippedNote = skipped.length > 0 ? ` Skipped ${skipped.length} file(s) over ${maxFileBytes} bytes.` : "";
  return {
    ok: true,
    created: true,
    existed_before: false,
    method: "git",
    run_id: runId,
    commit,
    skipped,
    message: `Private git baseline created at ${commit}. Nexus removes this .git when the run finishes only if it still holds just the baseline and this run's direct-edit seals.${skippedNote}`,
  };
}

function commitLines(result) {
  return String(result?.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function commitIdentity(root, sha, gitBin, env) {
  const info = run(gitBin, ["show", "-s", "--format=%an%x1f%ae%x1f%s", sha], root, env);
  if (info.status !== 0) return null;
  const [name, email, subject] = String(info.stdout || "").trim().split("\u001f");
  return { name, email, subject };
}

/**
 * Every commit reachable from HEAD must be this run's baseline or one of the
 * direct-edit seals recorded in the protected marker, in a straight chain from
 * the baseline, each with the Nexus identity. Anything else (a user commit, a
 * rebase, or a forged object) keeps `.git`.
 */
function sealChainBlocker(root, marker, gitBin, env) {
  const sealed = sealedCommits(marker);
  const expectedHead = sealed.length > 0 ? sealed[sealed.length - 1] : marker.commit;
  const head = run(gitBin, ["rev-parse", "HEAD"], root, env);
  const commit = head.status === 0 ? String(head.stdout || "").trim() : "";
  if (!commit || commit !== expectedHead) return "head-moved";
  const reachable = run(gitBin, ["rev-list", "HEAD"], root, env);
  if (reachable.status !== 0) return "extra-commits";
  const owned = new Set([marker.commit, ...sealed]);
  const listed = commitLines(reachable);
  if (listed.length !== owned.size || listed.some((sha) => !owned.has(sha))) return "extra-commits";
  const roots = run(gitBin, ["rev-list", "--max-parents=0", "HEAD"], root, env);
  if (roots.status !== 0 || commitLines(roots).join(" ") !== marker.commit) return "extra-commits";
  let parent = marker.commit;
  for (const sha of sealed) {
    const actual = run(gitBin, ["rev-parse", `${sha}^`], root, env);
    if (actual.status !== 0 || String(actual.stdout || "").trim() !== parent) return "extra-commits";
    parent = sha;
  }
  const expected = [
    [marker.commit, BASELINE_COMMIT_MESSAGE],
    ...sealed.map((sha) => [sha, DIRECT_EDIT_COMMIT_MESSAGE]),
  ];
  for (const [sha, subject] of expected) {
    const identity = commitIdentity(root, sha, gitBin, env);
    if (
      !identity ||
      identity.name !== LOCAL_NAME ||
      identity.email !== LOCAL_EMAIL ||
      identity.subject !== subject
    ) {
      return "foreign-commit";
    }
  }
  return null;
}

function removalBlocker(root, marker, gitBin, env) {
  const chain = sealChainBlocker(root, marker, gitBin, env);
  if (chain) return chain;
  const refs = run(gitBin, ["show-ref"], root, env);
  const names = String(refs.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).pop())
    .filter(Boolean);
  const heads = names.filter((name) => name.startsWith("refs/heads/"));
  const other = names.filter((name) => !name.startsWith("refs/heads/"));
  if (heads.length > 1 || other.length > 0) return "extra-refs";
  const worktrees = run(gitBin, ["worktree", "list", "--porcelain"], root, env);
  const listed = String(worktrees.stdout || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "));
  if (listed.length > 1) return "extra-worktrees";
  return null;
}

/**
 * Remove only a `.git` directory this run created, and only while its history
 * is exactly the run's baseline plus its own direct-edit seals.
 */
const BENIGN_CLEANUP_REASONS = new Set([
  "missing-run-id",
  "not-created-here",
  "not-a-git-baseline",
  "already-absent",
  "removed-private-baseline",
]);

export function cleanupPrivateBaseline(worktree, options = {}) {
  const result = removePrivateBaseline(worktree, options);
  return { ...result, kept: !result.removed && !BENIGN_CLEANUP_REASONS.has(result.reason) };
}

function removePrivateBaseline(worktree, options = {}) {
  const root = path.resolve(worktree);
  const runId = options.runId || null;
  if (!runId) return { ok: true, removed: false, reason: "missing-run-id" };
  const marker = readPrivateBaseline(root, runId);
  if (marker?.method === "content-hash" && marker.run_id === runId) {
    removeContentHashSnapshot(root, runId, marker);
    removeMarker(root, runId);
    return { ok: true, removed: false, reason: "not-a-git-baseline" };
  }
  if (!marker || marker.created !== true || marker.existed_before !== false || marker.run_id !== runId) {
    return { ok: true, removed: false, reason: "not-created-here" };
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
    if (error?.code === "ENOENT") {
      removeMarker(root, runId);
      return { ok: true, removed: false, reason: "already-absent" };
    }
    return { ok: false, removed: false, reason: error.message };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { ok: false, removed: false, reason: "refusing-non-directory-git" };
  }
  if (marker.worktree && !sameWorktree(marker.worktree, root)) {
    return { ok: false, removed: false, reason: "worktree-mismatch" };
  }
  if (!gitDirMatches(root, marker.git_dir)) {
    return { ok: false, removed: false, reason: "git-dir-identity-mismatch" };
  }
  const gitBin = options.gitBin || "git";
  const blocker = removalBlocker(root, marker, gitBin, env);
  if (blocker) return { ok: true, removed: false, reason: blocker };
  try {
    fs.rmSync(gitDir, { recursive: true, force: false });
  } catch (error) {
    return {
      ok: false,
      removed: false,
      reason: `cleanup-failed: ${error?.message || error}`,
    };
  }
  removeMarker(root, runId);
  return { ok: true, removed: true, reason: "removed-private-baseline" };
}

function sealFailure(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).find((line) => line.trim()) || "";
}

function sealedCommits(marker) {
  if (!Array.isArray(marker?.seal_commits)) return [];
  return marker.seal_commits.filter((sha) => typeof sha === "string" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha));
}

function ownedPrivateMarker(root, marker, runId) {
  return Boolean(
    marker &&
      marker.created === true &&
      marker.existed_before === false &&
      marker.method === "git" &&
      marker.run_id === runId &&
      marker.commit &&
      sameWorktree(marker.worktree, root) &&
      gitDirMatches(root, marker.git_dir),
  );
}

/**
 * Seal a direct-mode edit as a CLI-authored commit so verification has a real
 * HEAD. Only changed paths that are listed in `allowedFiles` are staged and
 * committed, with a pathspec so nothing else in the index is swept in. Any
 * change outside the list refuses the seal with a scope-drift error and
 * commits nothing. Only a repository this run created (protected marker) is
 * sealed; the orchestrator never runs git itself.
 */
export function sealDirectSelfEdit(worktree, options = {}) {
  const root = path.resolve(worktree);
  const gitBin = options.gitBin || "git";
  const env = options.env || process.env;
  const runId = options.runId || null;
  const marker = runId ? readPrivateBaseline(root, runId) : null;
  if (!ownedPrivateMarker(root, marker, runId)) {
    return sealFailure(
      "SEAL_NOT_PRIVATE",
      "direct seal refused: this workspace has no private baseline created by this run. Nexus commits only into the baseline it created; an existing repository stays on the standard pipeline. Nothing was committed.",
    );
  }
  const allowed = normalizeAllowedFiles(options.allowedFiles);
  const sealed = sealedCommits(marker);
  const expectedHead = sealed.length > 0 ? sealed[sealed.length - 1] : marker.commit;
  const head = run(gitBin, ["rev-parse", "HEAD"], root, env);
  if (head.status !== 0) {
    return sealFailure("SEAL_NO_HEAD", "direct seal requires a git HEAD. Start the run with nexus run init.");
  }
  const headCommit = String(head.stdout || "").trim();
  if (headCommit !== expectedHead) {
    return sealFailure(
      "SEAL_HEAD_MOVED",
      "direct seal refused: HEAD is not the last commit this run sealed. Nothing was committed.",
    );
  }
  const status = run(gitBin, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], root, env);
  if (status.status !== 0) {
    return sealFailure(
      "SEAL_STATUS_UNAVAILABLE",
      `direct seal cannot read git status. ${firstLine(status.stderr)}`.trim(),
    );
  }
  const changed = changedPathsFromEntries(parseStatusZ(status.stdout));
  if (changed.length === 0) return { ok: true, commit: headCommit, committed: false, files: [] };
  const outOfScope = outOfScopePaths(changed, allowed);
  if (outOfScope.length > 0) {
    return sealFailure(
      "DIRECT_SCOPE_DRIFT",
      `direct seal refused: ${outOfScope.length} path(s) changed outside allowed_files (${outOfScope.join(", ")}). Nothing was committed.`,
      { hint: SCOPE_DRIFT_HINT, out_of_scope: outOfScope, allowed_files: allowed },
    );
  }
  const staged = run(
    gitBin,
    ["--literal-pathspecs", "-c", "core.autocrlf=false", "add", "-A", "--", ...changed],
    root,
    env,
  );
  if (staged.status !== 0) {
    return sealFailure(
      "SEAL_STAGE_FAILED",
      `direct seal could not stage ${changed.join(", ")}. ${firstLine(staged.stderr)}`.trim(),
    );
  }
  const pending = run(
    gitBin,
    ["--literal-pathspecs", "diff", "--cached", "--name-only", "-z", "--", ...changed],
    root,
    env,
  );
  if (pending.status !== 0) {
    return sealFailure("SEAL_STAGE_FAILED", "direct seal cannot read the staged changes");
  }
  if (!String(pending.stdout || "").trim()) {
    return { ok: true, commit: headCommit, committed: false, files: [] };
  }
  const committed = withEmptyHooks((hooksPath) =>
    run(
      gitBin,
      ["--literal-pathspecs", ...commitCommand(hooksPath, { message: DIRECT_EDIT_COMMIT_MESSAGE }), "--", ...changed],
      root,
      env,
    ),
  );
  if (committed.status !== 0) {
    return sealFailure(
      "SEAL_COMMIT_FAILED",
      `direct seal could not commit ${changed.join(", ")}. ${firstLine(committed.stderr)}`.trim(),
    );
  }
  const after = run(gitBin, ["rev-parse", "HEAD"], root, env);
  const commit = after.status === 0 ? String(after.stdout || "").trim() : "";
  if (!commit) return sealFailure("SEAL_NO_HEAD", "direct seal failed: HEAD is unavailable after commit");
  writeMarker(root, runId, { ...marker, seal_commits: [...sealed, commit] });
  return { ok: true, commit, committed: true, files: changed };
}
