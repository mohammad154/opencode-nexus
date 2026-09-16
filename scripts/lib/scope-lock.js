import { spawnSync } from "node:child_process";
import path from "node:path";
import { scopeExpansionNeeded, normalizeAllowedFiles } from "./impact/boundaries.js";
import {
  DEFAULT_IGNORE_PATTERNS,
  filterPathEntries,
  isIgnoredPath,
  normalizeRelativePath,
  validateRuntimeRoots,
} from "./path-filter.js";
import { validateContainedPath } from "./filesystem-boundary.js";

/** Nexus/runtime paths are not implementer scope — same policy as diff-evidence. */
export function isNexusRuntimePath(file) {
  if (!file || typeof file !== "string") return false;
  const normalized = normalizeRelativePath(file);
  if (!normalized) return false;
  return (
    normalized === ".opencode" ||
    normalized.startsWith(".opencode/") ||
    normalized === "graphify-out" ||
    normalized.startsWith("graphify-out/") ||
    normalized === ".antigravity" ||
    normalized.startsWith(".antigravity/")
  );
}

function collectGitNameOnly(stdout, files, ignoredPatterns) {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const f = line.trim().replace(/\\/g, "/");
    if (f && !isNexusRuntimePath(f) && !isIgnoredPath(f, ignoredPatterns)) {
      files.add(f);
    }
  }
}

function entryPath(entry) {
  return typeof entry === "string" ? entry : entry?.path || entry?.file || "";
}

function boundaryReason(reason) {
  return reason === "outside_root" ? "outside_worktree" : reason;
}

function scopeBoundaryIssues(worktree, entries) {
  const issues = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const raw = entryPath(entry);
    const rel = normalizeRelativePath(raw);
    const key = rel || String(raw || "");
    if (seen.has(key)) continue;
    seen.add(key);
    if (!rel) {
      if (raw) issues.push({ path: String(raw), reason: "unsafe_path" });
      continue;
    }
    if (!worktree) continue;
    const boundary = validateContainedPath(
      worktree,
      path.resolve(worktree, rel),
      { allowMissing: true, rejectSymlinks: true },
    );
    if (!boundary.ok) {
      issues.push({
        path: rel,
        reason: boundaryReason(boundary.reason),
        ...(boundary.realpath ? { realpath: boundary.realpath } : {}),
      });
    }
  }
  return issues;
}

function runtimeBoundaryIssues(worktree) {
  if (!worktree) return [];
  const boundary = validateRuntimeRoots(worktree);
  if (boundary.ok) return [];
  return [
    {
      path: boundary.root || String(boundary.path || worktree),
      reason: boundaryReason(boundary.reason),
      ...(boundary.realpath ? { realpath: boundary.realpath } : {}),
    },
  ];
}

function unsafeScopeResult(issues, ignoredFiles = []) {
  return {
    ok: false,
    code: "SCOPE_UNSAFE_PATH",
    extras: issues.map((issue) => issue.path),
    unsafe_files: issues,
    ignored_files: ignoredFiles,
    message:
      "scope lock rejected unsafe or externally resolved paths — refusing to continue",
  };
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
  // The candidate worktree is mutable by the implementer. Never load a scope
  // policy from it while deriving the authoritative diff; custom patterns
  // could otherwise hide an out-of-scope edit before the lock checks it.
  const ignoredPatterns = DEFAULT_IGNORE_PATTERNS;

  const files = new Set();
  let gotAny = false;

  if (base && head) {
    const r = spawnSync("git", ["diff", "--name-only", base, head], {
      cwd: worktree,
      encoding: "utf8",
    });
    if (r.status === 0) {
      gotAny = true;
      collectGitNameOnly(r.stdout, files, ignoredPatterns);
    }
  } else if (base) {
    const r = spawnSync("git", ["diff", "--name-only", base], {
      cwd: worktree,
      encoding: "utf8",
    });
    if (r.status === 0) {
      gotAny = true;
      collectGitNameOnly(r.stdout, files, ignoredPatterns);
    }
  }

  // Also check working tree changes against HEAD / untracked if working in a worktree
  const wtDiff = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  });
  if (wtDiff.status === 0) {
    gotAny = true;
    collectGitNameOnly(wtDiff.stdout, files, ignoredPatterns);
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
    collectGitNameOnly(untracked.stdout, files, ignoredPatterns);
  }

  if (!gotAny) return null;
  return [...files];
}

export function assertScopeLock({
  allowed_files = [],
  changed_files = [],
  require_scope = true,
  worktree = null,
} = {}) {
  const allowed = normalizeAllowedFiles(allowed_files);
  const changedEntries =
    Array.isArray(changed_files) || changed_files == null
      ? changed_files || []
      : [changed_files];
  const unsafeAllowed = allowed.filter((file) => !normalizeRelativePath(file));
  if (unsafeAllowed.length > 0) {
    return unsafeScopeResult(
      unsafeAllowed.map((file) => ({ path: file, reason: "unsafe_path" })),
    );
  }
  const filtered = filterPathEntries(changedEntries, {
    ignoredPatterns: DEFAULT_IGNORE_PATTERNS,
    worktree,
  });
  const issues = [
    ...runtimeBoundaryIssues(worktree),
    ...scopeBoundaryIssues(worktree, changedEntries),
  ];
  if (issues.length > 0) return unsafeScopeResult(issues, filtered.ignored);
  if (allowed.length === 0 && require_scope !== false) {
    return {
      ok: false,
      code: "SCOPE_UNBOUND",
      message:
        "allowed_files must be non-empty for scope lock — empty scope fails closed",
    };
  }
  const measuredChangedFiles = filtered.included.map((entry) =>
    typeof entry === "string" ? entry : entry.path,
  );
  const check = scopeExpansionNeeded(allowed, measuredChangedFiles);
  if (!check.needed) {
    return {
      ok: true,
      allowed_files: allowed,
      ignored_files: filtered.ignored,
    };
  }
  return {
    ok: false,
    code: "SCOPE_EXPANSION_REQUIRED",
    extras: check.extras,
    ignored_files: filtered.ignored,
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
  const runtimeIssues = runtimeBoundaryIssues(worktree);
  if (runtimeIssues.length > 0) return unsafeScopeResult(runtimeIssues);
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
    worktree,
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
