/**
 * Git evidence for Nexus Impact Engine — scripts measure; agents do not invent diffs.
 */
import { spawnSync } from "node:child_process";

function runGit(worktree, args) {
  const r = spawnSync("git", args, {
    cwd: worktree,
    encoding: "utf8",
  });
  return {
    ok: r.status === 0,
    stdout: String(r.stdout || "").trim(),
    stderr: String(r.stderr || "").trim(),
    status: r.status,
  };
}

export function resolveBaseCommit(worktree, baseRef = "HEAD") {
  const head = runGit(worktree, ["rev-parse", "HEAD"]);
  if (!head.ok) return { ok: false, error: head.stderr || "cannot resolve HEAD" };

  let base = baseRef;
  if (baseRef === "merge-base" || baseRef === "auto") {
    const mb = runGit(worktree, ["merge-base", "HEAD", "origin/main"]);
    if (!mb.ok) {
      const mb2 = runGit(worktree, ["merge-base", "HEAD", "main"]);
      if (!mb2.ok) {
        // Fall back to empty tree / single commit parent
        const parent = runGit(worktree, ["rev-parse", "HEAD^"]);
        base = parent.ok ? parent.stdout : head.stdout;
      } else {
        base = mb2.stdout;
      }
    } else {
      base = mb.stdout;
    }
  } else if (baseRef !== "HEAD") {
    const resolved = runGit(worktree, ["rev-parse", baseRef]);
    if (!resolved.ok) return { ok: false, error: resolved.stderr || `cannot resolve ${baseRef}` };
    base = resolved.stdout;
  } else {
    // Working tree vs HEAD
    base = head.stdout;
  }

  return { ok: true, base_commit: base, head_commit: head.stdout };
}

export function collectGitEvidence(worktree, options = {}) {
  const baseInfo = resolveBaseCommit(worktree, options.base || "HEAD");
  if (!baseInfo.ok) return baseInfo;

  const { base_commit, head_commit } = baseInfo;
  const againstWorkingTree = options.base === "HEAD" || !options.base;

  const nameStatusArgs = againstWorkingTree
    ? ["diff", "--name-status", "HEAD"]
    : ["diff", "--name-status", base_commit, head_commit];
  const numstatArgs = againstWorkingTree
    ? ["diff", "--numstat", "HEAD"]
    : ["diff", "--numstat", base_commit, head_commit];
  const u0Args = againstWorkingTree
    ? ["diff", "-U0", "HEAD"]
    : ["diff", "-U0", base_commit, head_commit];

  const nameStatus = runGit(worktree, nameStatusArgs);
  const numstat = runGit(worktree, numstatArgs);
  const u0 = runGit(worktree, u0Args);

  const changed_files = [];
  let added_lines = 0;
  let deleted_lines = 0;

  if (nameStatus.ok && nameStatus.stdout) {
    for (const line of nameStatus.stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split(/\t/);
      const status = parts[0];
      const file = parts[parts.length - 1];
      if (file) changed_files.push({ status, path: file.replace(/\\/g, "/") });
    }
  }

  if (numstat.ok && numstat.stdout) {
    for (const line of numstat.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [a, d] = line.split(/\t/);
      if (a !== "-" && Number.isFinite(Number(a))) added_lines += Number(a);
      if (d !== "-" && Number.isFinite(Number(d))) deleted_lines += Number(d);
    }
  }

  // Also include untracked files when comparing to HEAD
  if (againstWorkingTree) {
    const untracked = runGit(worktree, ["ls-files", "--others", "--exclude-standard"]);
    if (untracked.ok && untracked.stdout) {
      for (const file of untracked.stdout.split("\n")) {
        if (!file.trim()) continue;
        const path = file.replace(/\\/g, "/");
        if (!changed_files.some((f) => f.path === path)) {
          changed_files.push({ status: "A", path });
        }
      }
    }
  }

  return {
    ok: true,
    base_commit,
    head_commit,
    changed_files,
    added_lines,
    deleted_lines,
    unified_diff_u0: u0.ok ? u0.stdout : "",
    source: "git",
  };
}
