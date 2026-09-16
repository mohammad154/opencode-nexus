/**
 * Shared path policy for measured impact evidence, verification targets, and
 * scope-lock diffs.
 *
 * Runtime/build artifacts are deliberately filtered before they can influence
 * an index, a verification command, or an implementer scope decision.
 */
import fs from "node:fs";
import path from "node:path";
import { validateContainedPath } from "./filesystem-boundary.js";

export const PATH_FILTER_VERSION = "nexus-path-filter-1.1";

export const DEFAULT_IGNORE_PATTERNS = Object.freeze([
  ".git/**",
  "node_modules/**",
  ".node_modules/**",
  ".venv/**",
  "venv/**",
  "__pycache__/**",
  "*.pyc",
  "*.pyo",
  "dist/**",
  "build/**",
  "coverage/**",
  ".cache/**",
  ".tmp/**",
  // Nexus artifacts are runtime evidence, not implementer source.
  ".opencode/**",
  "graphify-out/**",
  ".antigravity/**",
]);

export const DEFAULT_SCOPE_ALLOWED_PATTERNS = Object.freeze([
  ".opencode/**",
  "src/**",
  "tests/**",
  "plan/**",
]);

export const DEFAULT_SCOPE_POLICY = Object.freeze({
  schema_version: "1.0",
  allowed: DEFAULT_SCOPE_ALLOWED_PATTERNS,
  ignored: DEFAULT_IGNORE_PATTERNS,
});

export const DEFAULT_RUNTIME_ROOTS = Object.freeze([
  ".opencode",
  ".opencode/runs",
  ".opencode/reviews",
  ".opencode/worktrees",
  "graphify-out",
  ".antigravity",
]);

function normalizePattern(pattern) {
  return String(pattern || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

/** Normalize a repository-relative path, returning null for unsafe paths. */
export function normalizeRelativePath(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return null;
  }
  if (
    normalized.split("/").some((part) => part === "." || part === "..") ||
    normalized.includes("\0")
  ) {
    return null;
  }
  return normalized;
}

/**
 * Runtime roots are repository-owned state directories. Reject an existing
 * symlink before any caller reads or writes through it.
 */
export function validateRuntimeRoots(
  worktree,
  roots = DEFAULT_RUNTIME_ROOTS,
) {
  if (typeof worktree !== "string" || !worktree) {
    return { ok: false, reason: "invalid_path", path: String(worktree || "") };
  }
  for (const relative of Array.isArray(roots) ? roots : []) {
    if (typeof relative !== "string" || !relative) {
      return { ok: false, reason: "invalid_path", root: String(relative || "") };
    }
    const candidate = path.join(worktree, relative);
    const result = validateContainedPath(worktree, candidate, {
      allowMissing: true,
      rejectSymlinks: true,
    });
    if (!result.ok) return { ...result, root: relative };
    if (result.exists) {
      try {
        if (!fs.statSync(candidate).isDirectory()) {
          return { ...result, ok: false, reason: "not_directory", root: relative };
        }
      } catch {
        return { ...result, ok: false, reason: "unreadable_root", root: relative };
      }
    }
  }
  return { ok: true };
}

function globRegex(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i += 1;
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[|\\{}()[\]^$+*.]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

function patternMatches(rel, rawPattern) {
  const pattern = normalizePattern(rawPattern);
  if (!pattern) return false;
  // A basename pattern such as *.pyc applies at every repository depth.
  if (!pattern.includes("/")) {
    return globRegex(pattern).test(path.posix.basename(rel));
  }
  return globRegex(pattern).test(rel);
}

/** Return the first matching ignore pattern, or null when the path is allowed. */
export function matchingIgnorePattern(rel, patterns = DEFAULT_IGNORE_PATTERNS) {
  const normalized = normalizeRelativePath(rel);
  if (!normalized) return null;
  return (patterns || []).find((pattern) => patternMatches(normalized, pattern)) || null;
}

export function isIgnoredPath(rel, patterns = DEFAULT_IGNORE_PATTERNS) {
  return Boolean(matchingIgnorePattern(rel, patterns));
}

/**
 * Filter strings or path-bearing objects while preserving object metadata.
 * The ignored list is evidence that can be surfaced in reports and tests.
 */
export function filterPathEntries(
  entries = [],
  { ignoredPatterns = DEFAULT_IGNORE_PATTERNS, worktree = null } = {},
) {
  const included = [];
  const ignored = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const raw = typeof entry === "string" ? entry : entry?.path || entry?.file;
    const normalized = normalizeRelativePath(raw);
    const key = normalized || String(raw || "");
    if (seen.has(key)) continue;
    seen.add(key);
    if (!normalized) {
      if (raw) ignored.push({ path: String(raw), reason: "unsafe_path" });
      continue;
    }
    if (worktree) {
      const boundary = validateContainedPath(
        worktree,
        path.resolve(worktree, normalized),
        { allowMissing: true, rejectSymlinks: true },
      );
      if (!boundary.ok) {
        ignored.push({
          path: normalized,
          reason:
            boundary.reason === "outside_root"
              ? "outside_worktree"
              : boundary.reason,
          ...(boundary.realpath ? { realpath: boundary.realpath } : {}),
        });
        continue;
      }
    }
    const pattern = matchingIgnorePattern(normalized, ignoredPatterns);
    if (pattern) {
      ignored.push({ path: normalized, reason: "ignored", pattern });
      continue;
    }
    if (typeof entry === "string") included.push(normalized);
    else included.push({ ...entry, path: normalized });
  }
  return { included, ignored };
}

export function filterPaths(paths = [], options = {}) {
  return filterPathEntries(paths, options);
}

function asPatterns(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizePattern).filter(Boolean);
}

/**
 * Load the project scope policy. Defaults remain active even when a project
 * adds custom patterns, so a local policy cannot re-enable runtime noise.
 */
export function loadScopePolicy(worktree = process.cwd()) {
  const root = typeof worktree === "string" && worktree ? worktree : "";
  const policyPath = root
    ? path.join(root, ".opencode", "config", "scope-policy.json")
    : "";
  const fallback = {
    schema_version: DEFAULT_SCOPE_POLICY.schema_version,
    allowed: [...DEFAULT_SCOPE_ALLOWED_PATTERNS],
    ignored: [...DEFAULT_IGNORE_PATTERNS],
    ignored_patterns: [...DEFAULT_IGNORE_PATTERNS],
    source: "default",
    path: policyPath,
  };
  const boundary = validateContainedPath(root, policyPath, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  if (!boundary.ok) {
    return {
      ...fallback,
      source: "default-unsafe",
      error: `scope policy path violates filesystem boundary (${boundary.reason})`,
    };
  }
  if (!fs.existsSync(policyPath)) return fallback;

  try {
    const raw = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    const allowed = asPatterns(raw.allowed || raw.allowed_patterns);
    const customIgnored = asPatterns(
      raw.ignored || raw.ignore || raw.ignore_patterns,
    );
    const ignored = [...new Set([...DEFAULT_IGNORE_PATTERNS, ...customIgnored])];
    return {
      schema_version: String(raw.schema_version || "1.0"),
      allowed: allowed.length ? allowed : [...DEFAULT_SCOPE_ALLOWED_PATTERNS],
      ignored,
      ignored_patterns: ignored,
      source: "project",
      path: policyPath,
    };
  } catch (error) {
    return {
      ...fallback,
      source: "default-invalid",
      error: String(error.message || error),
    };
  }
}
