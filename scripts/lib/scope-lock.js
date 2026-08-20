import { spawnSync } from "node:child_process";
import { scopeExpansionNeeded, normalizeAllowedFiles } from "./impact/boundaries.js";

/**
 * Derive actual changed files from git diff between base and implementer commits,
 * including any working tree or untracked changes if in a worktree.
 */
export function getChangedFilesFromGit(
  worktree,
  { base_commit, implementer_commit, head_commit } = {},
) {
  if (!worktree) return null;
  const base = base_commit;
  const head = implementer_commit || head_commit;

  const files = new Set();
  let gotAny = false;

  if (base && head) {
    const r = spawnSync("git", ["diff", "--name-only", base, head], {
      cwd: worktree,
      encoding: "utf8",
    });
    if (r.status === 0) {
      gotAny = true;
      for (const line of (r.stdout || "").split(/\r?\n/)) {
        const f = line.trim().replace(/\\/g, "/");
        if (f) files.add(f);
      }
    }
  } else if (base) {
    const r = spawnSync("git", ["diff", "--name-only", base], {
      cwd: worktree,
      encoding: "utf8",
    });
    if (r.status === 0) {
      gotAny = true;
      for (const line of (r.stdout || "").split(/\r?\n/)) {
        const f = line.trim().replace(/\\/g, "/");
        if (f) files.add(f);
      }
    }
  }

  // Also check working tree changes against HEAD / untracked if working in a worktree
  const wtDiff = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  });
  if (wtDiff.status === 0) {
    gotAny = true;
    for (const line of (wtDiff.stdout || "").split(/\r?\n/)) {
      const f = line.trim().replace(/\\/g, "/");
      if (f) files.add(f);
    }
  }

  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    {
      cwd: worktree,
      encoding: "utf8",
    },
  );
  if (untracked.status === 0) {
    gotAny = true;
    for (const line of (untracked.stdout || "").split(/\r?\n/)) {
      const f = line.trim().replace(/\\/g, "/");
      if (f) files.add(f);
    }
  }

  if (!gotAny) return null;
  return [...files];
}

export function assertScopeLock({
  allowed_files = [],
  changed_files = [],
  require_scope = true,
} = {}) {
  const allowed = normalizeAllowedFiles(allowed_files);
  if (allowed.length === 0 && require_scope !== false) {
    return {
      ok: false,
      code: "SCOPE_UNBOUND",
      message:
        "allowed_files must be non-empty for scope lock — empty scope fails closed",
    };
  }
  const check = scopeExpansionNeeded(allowed, changed_files);
  if (!check.needed) {
    return { ok: true, allowed_files: allowed };
  }
  return {
    ok: false,
    code: "SCOPE_EXPANSION_REQUIRED",
    extras: check.extras,
    message:
      "Implementer attempted out-of-scope edits; STOP, request scope expansion, rerun impact",
  };
}

export function assertTransitionScopeLock({
  state = {},
  ctx = {},
  handoffData = null,
} = {}) {
  const allowedFiles =
    ctx.allowed_files ??
    state.allowed_files ??
    ctx.implementer_context?.allowed_files ??
    state.implementer_context?.allowed_files ??
    handoffData?.allowed_files;

  if (allowedFiles == null) {
    return { ok: true, skipped: true };
  }

  const worktree = ctx.worktree || state.worktree;
  const baseCommit =
    handoffData?.base_commit ||
    ctx.base_commit ||
    state.head_commit ||
    state.plan_commit ||
    ctx.base;
  const implementerCommit =
    handoffData?.commit ||
    ctx.implementer_commit ||
    ctx.commit ||
    state.implementer_commit;

  let changedFiles = null;
  if (worktree) {
    changedFiles = getChangedFilesFromGit(worktree, {
      base_commit: baseCommit,
      implementer_commit: implementerCommit,
    });
  }

  if (changedFiles == null) {
    changedFiles =
      ctx.changed_files ||
      state.changed_files ||
      handoffData?.changed_files ||
      handoffData?.files_changed ||
      [];
  }

  return assertScopeLock({
    allowed_files: allowedFiles,
    changed_files: changedFiles,
    require_scope: true,
  });
}

export function buildFreshImplementerContext({
  task,
  acceptance_criteria = [],
  allowed_files = [],
  impact = null,
  baseline = null,
  verification_commands = [],
} = {}) {
  return {
    task,
    acceptance_criteria,
    allowed_files: normalizeAllowedFiles(allowed_files),
    impact_summary: impact
      ? {
          risk: impact.risk,
          confidence: impact.confidence,
          changed_files: impact.changed_files,
          related_tests: impact.related_tests,
        }
      : null,
    baseline,
    verification_commands,
  };
}
