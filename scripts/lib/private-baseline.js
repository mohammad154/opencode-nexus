/**
 * Private git baseline for workspaces that are not already a repository.
 *
 * Nexus creates the repo itself. It never asks the orchestrator to run
 * git init/add/commit, never writes global git config, and never commits
 * into an existing repository. The marker lives under
 * `.opencode/runs/<run_id>/`, which agents cannot edit. `.git` is removed
 * only when this run created it and HEAD is still exactly that one baseline
 * commit, with no other refs or worktrees. A content-hash snapshot is used
 * only when the git binary itself is missing.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateContainedPath } from "./filesystem-boundary.js";
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
  "dist",
  "build",
  "coverage",
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
  if (!worktree || !runId) return null;
  return path.join(worktree, ".opencode", "runs", String(runId), "private-baseline.json");
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

function removeMarker(worktree, runId) {
  const file = baselineMarkerPath(worktree, runId);
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // The git directory was already removed. A leftover marker is not a repo.
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
  const { entries, digest } = snapshotEntries(worktree);
  const snapshotRelative = path.join(".opencode", "baselines", `${runId}-content-hash.json`);
  const snapshot = {
    method: "content-hash",
    algorithm: "sha256",
    run_id: runId,
    digest,
    commit: `content-hash:${digest.slice(0, 12)}`,
    files: entries,
    created_at: new Date().toISOString(),
  };
  const file = path.join(worktree, snapshotRelative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const marker = {
    created: false,
    existed_before: false,
    method: "content-hash",
    run_id: runId,
    commit: snapshot.commit,
    digest,
    snapshot: snapshotRelative.replace(/\\/g, "/"),
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
      "Git is not available. Recorded a content-hash baseline under .opencode/baselines instead of a commit.",
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
      const saved = JSON.parse(fs.readFileSync(path.join(worktree, marker.snapshot), "utf8"));
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

function emptyHooksPath(root) {
  const hooks = path.join(root, ".git", "nexus-empty-hooks");
  fs.mkdirSync(hooks, { recursive: true });
  return hooks.replace(/\\/g, "/");
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
    "dist/",
    "build/",
    "coverage/",
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
  if (!runId) {
    return {
      ok: false,
      created: false,
      method: "git",
      message: "Private git baseline requires a run_id.",
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
  const hooksPath = emptyHooksPath(root);
  let committed = run(gitBin, commitCommand(hooksPath, { message: BASELINE_COMMIT_MESSAGE }), root, env);
  if (committed.status !== 0) {
    committed = run(
      gitBin,
      commitCommand(hooksPath, { message: BASELINE_COMMIT_MESSAGE, empty: true }),
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
    skipped,
  };
  writeMarker(root, runId, marker);
  const skippedNote = skipped.length > 0 ? ` Skipped ${skipped.length} file(s) over ${maxFileBytes} bytes.` : "";
  return {
    ok: true,
    created: true,
    existed_before: false,
    method: "git",
    run_id: runId,
    commit,
    skipped,
    message: `Private git baseline created at ${commit}. Nexus removes this .git only if it is still the sole commit when the run finishes.${skippedNote}`,
  };
}

function removalBlocker(root, marker, gitBin, env) {
  const head = run(gitBin, ["rev-parse", "HEAD"], root, env);
  const commit = head.status === 0 ? String(head.stdout || "").trim() : "";
  if (!commit || commit !== marker.commit) return "head-moved";
  const count = run(gitBin, ["rev-list", "--count", "HEAD"], root, env);
  if (count.status !== 0 || Number(String(count.stdout || "").trim()) !== 1) return "extra-commits";
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
 * Remove only a `.git` directory this run created, and only while HEAD is
 * still exactly the baseline commit.
 */
export function cleanupPrivateBaseline(worktree, options = {}) {
  const root = path.resolve(worktree);
  const runId = options.runId || null;
  if (!runId) return { ok: true, removed: false, reason: "missing-run-id" };
  const marker = readPrivateBaseline(root, runId);
  if (!marker || marker.created !== true || marker.existed_before !== false || marker.run_id !== runId) {
    return { ok: true, removed: false, reason: "not-created-here" };
  }
  if (marker.method !== "git") {
    removeMarker(root, runId);
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

/**
 * Seal a direct-mode edit as a CLI-authored commit so verification has a real
 * HEAD. Only changed paths that are listed in `allowedFiles` are staged and
 * committed, with a pathspec so nothing else in the index is swept in. Any
 * change outside the list refuses the seal with a scope-drift error and
 * commits nothing. The orchestrator never runs git itself.
 */
export function sealDirectSelfEdit(worktree, options = {}) {
  const root = path.resolve(worktree);
  const gitBin = options.gitBin || "git";
  const env = options.env || process.env;
  const allowed = normalizeAllowedFiles(options.allowedFiles);
  const head = run(gitBin, ["rev-parse", "HEAD"], root, env);
  if (head.status !== 0) {
    return sealFailure("SEAL_NO_HEAD", "direct seal requires a git HEAD. Start the run with nexus run init.");
  }
  const headCommit = String(head.stdout || "").trim();
  try {
    ensureExclude(root);
  } catch (error) {
    return sealFailure("SEAL_EXCLUDE_FAILED", `direct seal could not update .git/info/exclude: ${error.message}`);
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
  let hooksPath;
  try {
    hooksPath = emptyHooksPath(root);
  } catch (error) {
    return sealFailure("SEAL_HOOKS_FAILED", `direct seal could not disable hooks: ${error.message}`);
  }
  const committed = run(
    gitBin,
    [
      "--literal-pathspecs",
      ...commitCommand(hooksPath, { message: DIRECT_EDIT_COMMIT_MESSAGE }),
      "--",
      ...changed,
    ],
    root,
    env,
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
  return { ok: true, commit, committed: true, files: changed };
}
