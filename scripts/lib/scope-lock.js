import { spawnSync } from "node:child_process";
import { scopeExpansionNeeded, normalizeAllowedFiles } from "./impact/boundaries.js";

/** Nexus/runtime paths are not implementer scope — same policy as diff-evidence. */
export function isNexusRuntimePath(file) {
  if (!file || typeof file !== "string") return false;
  const normalized = file.replace(/\\/g, "/");
  return (
    normalized === ".opencode" ||
    normalized.startsWith(".opencode/") ||
    normalized === "graphify-out" ||
    normalized.startsWith("graphify-out/")
  );
}

function collectGitNameOnly(stdout, files) {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const f = line.trim().replace(/\\/g, "/");
    if (f && !isNexusRuntimePath(f)) files.add(f);
  }
}

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
      collectGitNameOnly(r.stdout, files);
    }
  } else if (base) {
    const r = spawnSync("git", ["diff", "--name-only", base], {
      cwd: worktree,
      encoding: "utf8",
    });
    if (r.status === 0) {
      gotAny = true;
      collectGitNameOnly(r.stdout, files);
    }
  }

  // Also check working tree changes against HEAD / untracked if working in a worktree
  const wtDiff = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  });
  if (wtDiff.status === 0) {
    gotAny = true;
    collectGitNameOnly(wtDiff.stdout, files);
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
    collectGitNameOnly(untracked.stdout, files);
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

function resolveAllowedFiles({ state = {}, ctx = {}, handoffData = null } = {}) {
  return (
    ctx.allowed_files ??
    state.allowed_files ??
    ctx.implementer_context?.allowed_files ??
    state.implementer_context?.allowed_files ??
    handoffData?.allowed_files ??
    null
  );
}

/**
 * Authoritative scope gate for VERIFYING (and related) transitions.
 * Fail-closed: missing allowed_files → SCOPE_UNBOUND.
 * With a worktree, only git-derived diffs are trusted (never handoff claims).
 * Without a worktree, only engine-supplied ctx/state.changed_files are used —
 * implementer handoff files_changed is ignored.
 */
export function assertTransitionScopeLock({
  state = {},
  ctx = {},
  handoffData = null,
} = {}) {
  const policy = state?.verification_policy;
  if (policy && policy.exempt === true) {
    return { ok: true, skipped: true, reason: "verification_policy.exempt" };
  }

  const allowedFiles = resolveAllowedFiles({ state, ctx, handoffData });
  if (allowedFiles == null) {
    return {
      ok: false,
      code: "SCOPE_UNBOUND",
      message:
        "allowed_files must be persisted before VERIFYING — missing scope fails closed",
    };
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
    if (changedFiles == null) {
      return {
        ok: false,
        code: "SCOPE_EVIDENCE_UNAVAILABLE",
        message:
          "authoritative git diff unavailable for scope lock — refusing handoff-claimed changed_files",
      };
    }
  } else {
    // Engine/orchestrator-measured only. Never trust implementer handoff claims.
    if (Array.isArray(ctx.changed_files)) {
      changedFiles = ctx.changed_files;
    } else if (Array.isArray(state.changed_files)) {
      changedFiles = state.changed_files;
    } else {
      changedFiles = [];
    }
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
