/**
 * Deterministic project reconnaissance cache (PR5.B).
 *
 * Planning repeats the same repository-level reconnaissance on every run:
 * package manager, ecosystem, verification commands, CI configuration, agent
 * guides, intent/ADR locations, and memory locations. Those facts are
 * repository-level, not task-level, so they can be measured once and reused
 * while their *source content* is unchanged.
 *
 * Three rules keep this safe:
 *
 * 1. Identity is source-content based, via the existing
 *    `projectProfileIdentity()`. A HEAD change alone does not invalidate the
 *    profile; a change to `package.json`, CI config, or an agent guide does.
 * 2. Only repository-level facts are cached. Task-specific semantic
 *    conclusions (which file to change, which test to extend, which exemplar
 *    to copy) are never cached: the planner must still read them.
 * 3. The profile is **advisory only**. It can never authorize `PLANNED`,
 *    `TASK_IMPACT_READY`, `VERIFYING`, `REVIEWING`, or `COMPLETED`, and no
 *    gate module imports it.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectProfileIdentity } from "./evidence-identity.js";
import { discoverVerification } from "./verification/discover.js";
import { validateContainedPath } from "./filesystem-boundary.js";

/** Bump when the cached fact contract changes in a non-equivalent way. */
export const PROJECT_PROFILE_VERSION = "nexus-project-profile/1";
export const PROJECT_PROFILE_SCHEMA_VERSION = "1.0";

/** Advisory cache location, relative to the project worktree. */
export const PROJECT_PROFILE_CACHE_PATH = ".opencode/cache/project-profile.json";

/**
 * States a project profile may never authorize. Kept explicit so the trust rule
 * is greppable from the module that would be tempted to violate it.
 */
export const PROJECT_PROFILE_AUTHORIZES = Object.freeze([]);
export const PROJECT_PROFILE_FORBIDDEN_AUTHORITY = Object.freeze([
  "PLANNED",
  "TASK_IMPACT_READY",
  "VERIFYING",
  "REVIEWING",
  "COMPLETED",
]);

/**
 * Fixed identity candidates. Present *and absent* candidates are part of the
 * identity, so creating `AGENTS.md` invalidates a profile built without it.
 */
const MANIFEST_CANDIDATES = Object.freeze([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lockb",
  "deno.json",
  "deno.jsonc",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "requirements.txt",
  "uv.lock",
  "poetry.lock",
  "Pipfile",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "composer.json",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Makefile",
  "justfile",
]);

const CI_CANDIDATES = Object.freeze([
  ".gitlab-ci.yml",
  ".travis.yml",
  "azure-pipelines.yml",
  "Jenkinsfile",
  ".circleci/config.yml",
  "buildspec.yml",
]);

const GUIDE_CANDIDATES = Object.freeze([
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "CONTRIBUTING.rst",
  "README.md",
]);

const INTENT_CANDIDATES = Object.freeze([
  "PRODUCT.md",
  "DESIGN.md",
  "CONTEXT.md",
  "docs/architecture.md",
  "docs/adr",
  "docs/decisions",
  "adr",
]);

const MEMORY_CANDIDATES = Object.freeze([
  ".opencode/reflections/LESSONS.md",
  ".opencode/memory",
  ".opencode/CONTEXT.md",
]);

const PACKAGE_MANAGER_LOCKFILES = Object.freeze([
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lockb"],
  ["npm", "package-lock.json"],
  ["npm", "npm-shrinkwrap.json"],
  ["poetry", "poetry.lock"],
  ["uv", "uv.lock"],
  ["pipenv", "Pipfile.lock"],
  ["cargo", "Cargo.lock"],
  ["go", "go.sum"],
  ["bundler", "Gemfile.lock"],
  ["composer", "composer.lock"],
]);

function posix(relative) {
  return String(relative || "").replace(/\\/g, "/");
}

function safeRoot(worktree) {
  return path.resolve(String(worktree || process.cwd()));
}

function existsFile(root, relative) {
  try {
    return fs.lstatSync(path.join(root, relative)).isFile();
  } catch {
    return false;
  }
}

function existsDir(root, relative) {
  try {
    return fs.lstatSync(path.join(root, relative)).isDirectory();
  } catch {
    return false;
  }
}

function listFiles(root, relativeDir, { extensions = null, limit = 50 } = {}) {
  if (!existsDir(root, relativeDir)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(root, relativeDir), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) =>
      extensions
        ? extensions.some((extension) => name.toLowerCase().endsWith(extension))
        : true,
    )
    .sort()
    .slice(0, limit)
    .map((name) => posix(path.join(relativeDir, name)));
}

/** Discovered CI workflow files (dynamic members of the identity). */
function discoverCiPaths(root) {
  const found = [
    ...listFiles(root, ".github/workflows", { extensions: [".yml", ".yaml"] }),
  ];
  for (const candidate of CI_CANDIDATES) {
    if (existsFile(root, candidate)) found.push(posix(candidate));
  }
  return [...new Set(found)].sort();
}

function discoverIntentDocs(root) {
  const found = [];
  for (const candidate of INTENT_CANDIDATES) {
    if (existsFile(root, candidate)) {
      found.push(posix(candidate));
      continue;
    }
    if (existsDir(root, candidate)) {
      found.push(...listFiles(root, candidate, { extensions: [".md"] }));
    }
  }
  return [...new Set(found)].sort();
}

function discoverMemoryPaths(root) {
  const found = [];
  for (const candidate of MEMORY_CANDIDATES) {
    if (existsFile(root, candidate)) found.push(posix(candidate));
    else if (existsDir(root, candidate)) {
      found.push(...listFiles(root, candidate, { extensions: [".md", ".json"] }));
    }
  }
  return [...new Set(found)].sort();
}

/**
 * Every file whose *content* participates in profile identity. The list mixes
 * fixed candidates (so an added file invalidates) with discovered CI/intent
 * files (so an edited workflow invalidates).
 */
export function profileSourceFiles(worktree) {
  const root = safeRoot(worktree);
  return [
    ...new Set([
      ...MANIFEST_CANDIDATES.map(posix),
      ...CI_CANDIDATES.map(posix),
      ...GUIDE_CANDIDATES.map(posix),
      ...discoverCiPaths(root),
      ...discoverIntentDocs(root),
      ".opencode/config/scope-policy.json",
    ]),
  ].sort();
}

function readJson(root, relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  } catch {
    return null;
  }
}

function detectPackageManager(root, ecosystem) {
  for (const [manager, lockfile] of PACKAGE_MANAGER_LOCKFILES) {
    if (existsFile(root, lockfile)) return manager;
  }
  if (ecosystem === "node" && existsFile(root, "package.json")) return "npm";
  if (ecosystem === "python") return "pip";
  if (ecosystem === "rust") return "cargo";
  if (ecosystem === "go") return "go";
  return null;
}

function commandText(step) {
  if (!step || typeof step !== "object") return null;
  const command = String(step.command || "").trim();
  if (!command) return null;
  const args = Array.isArray(step.args) ? step.args : [];
  return [command, ...args.map((arg) => String(arg))].join(" ").trim();
}

/**
 * Advisory verification commands per role. `discoverVerification()` remains the
 * authoritative discovery used by `nexus verify`; this only records what it
 * reported so the planner does not have to re-derive gates by reading configs.
 */
function detectCommands(root) {
  let discovery = null;
  try {
    discovery = discoverVerification(root, {});
  } catch {
    discovery = null;
  }
  const commands = { test: null, lint: null, typecheck: null, build: null };
  const roleAliases = { vet: "lint", check: "typecheck" };
  const steps = Array.isArray(discovery?.steps) ? discovery.steps : [];
  for (const step of steps) {
    const raw = String(step?.kind || step?.id || "").toLowerCase();
    const role = roleAliases[raw] || raw;
    if (!(role in commands) || commands[role]) continue;
    if (step?.status === "UNAVAILABLE") continue;
    commands[role] = commandText(step);
  }
  return { commands, ecosystem: discovery?.ecosystem || "generic" };
}

function gitText(root, args) {
  try {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) return null;
    const value = String(result.stdout || "").trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Base branch as configured, never as guessed. `origin/HEAD` first, then an
 * existing conventional branch, otherwise null (callers must ask).
 */
function detectBaseBranch(root) {
  const originHead = gitText(root, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead) return originHead.replace(/^origin\//, "");
  for (const candidate of ["main", "master", "develop"]) {
    if (gitText(root, ["rev-parse", "--verify", "--quiet", candidate])) {
      return candidate;
    }
  }
  return null;
}

function rootConfigMetadata(root) {
  const pkg = readJson(root, "package.json");
  const files = MANIFEST_CANDIDATES.filter((candidate) =>
    existsFile(root, candidate),
  ).map(posix);
  return {
    files,
    name: typeof pkg?.name === "string" ? pkg.name : null,
    version: typeof pkg?.version === "string" ? pkg.version : null,
    module_type: typeof pkg?.type === "string" ? pkg.type : null,
    engines_node: typeof pkg?.engines?.node === "string" ? pkg.engines.node : null,
    package_scripts:
      pkg?.scripts && typeof pkg.scripts === "object"
        ? Object.keys(pkg.scripts).sort()
        : [],
    workspaces: Array.isArray(pkg?.workspaces)
      ? pkg.workspaces.map((entry) => String(entry))
      : [],
  };
}

/**
 * Measure the repository-level facts. Always fresh: this is the "rebuild" side
 * of the cache, so it never reads the cache file.
 */
export function buildProjectProfile(worktree) {
  const root = safeRoot(worktree);
  const sources = profileSourceFiles(root);
  const identity = projectProfileIdentity(root, sources);
  const { commands, ecosystem } = detectCommands(root);
  return {
    schema_version: PROJECT_PROFILE_SCHEMA_VERSION,
    version: PROJECT_PROFILE_VERSION,
    advisory: true,
    authorizes: [...PROJECT_PROFILE_AUTHORIZES],
    identity,
    generated_at: new Date().toISOString(),
    facts: {
      ecosystem,
      package_manager: detectPackageManager(root, ecosystem),
      commands,
      ci_config_paths: discoverCiPaths(root),
      guide_paths: GUIDE_CANDIDATES.filter((candidate) =>
        existsFile(root, candidate),
      ).map(posix),
      intent_paths: discoverIntentDocs(root),
      memory_paths: discoverMemoryPaths(root),
      base_branch: detectBaseBranch(root),
      root_config: rootConfigMetadata(root),
    },
    sources,
  };
}

function cacheFile(worktree) {
  const root = safeRoot(worktree);
  const absolute = path.join(root, PROJECT_PROFILE_CACHE_PATH);
  const boundary = validateContainedPath(root, absolute, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  return boundary.ok ? absolute : null;
}

/**
 * Read the cached profile without trusting it. A profile with a different
 * version, a missing identity, or an identity that no longer matches the
 * current source content is discarded rather than repaired.
 */
export function loadProjectProfile(worktree) {
  const root = safeRoot(worktree);
  const file = cacheFile(root);
  if (!file) return { ok: false, reason: "CACHE_PATH_REJECTED", profile: null };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === "ENOENT" ? "CACHE_MISSING" : "CACHE_UNREADABLE",
      profile: null,
      path: file,
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "CACHE_MALFORMED", profile: null, path: file };
  }
  if (raw.version !== PROJECT_PROFILE_VERSION) {
    return { ok: false, reason: "VERSION_CHANGED", profile: null, path: file };
  }
  const sources = Array.isArray(raw.sources) ? raw.sources : null;
  if (!sources || sources.length === 0) {
    return { ok: false, reason: "SOURCES_MISSING", profile: null, path: file };
  }
  const currentSources = profileSourceFiles(root);
  const sameSourceList =
    currentSources.length === sources.length &&
    currentSources.every((entry, index) => entry === sources[index]);
  if (!sameSourceList) {
    return { ok: false, reason: "SOURCE_SET_CHANGED", profile: null, path: file };
  }
  const identity = projectProfileIdentity(root, currentSources);
  if (!identity || identity !== raw.identity) {
    return {
      ok: false,
      reason: identity ? "IDENTITY_CHANGED" : "IDENTITY_UNAVAILABLE",
      profile: null,
      path: file,
    };
  }
  return { ok: true, reason: "IDENTITY_MATCH", profile: raw, path: file };
}

function writeProfile(worktree, profile) {
  const file = cacheFile(worktree);
  if (!file) return { written: false, reason: "CACHE_PATH_REJECTED", path: null };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    return { written: true, reason: null, path: file };
  } catch (error) {
    // An advisory cache must never fail the caller.
    return {
      written: false,
      reason: `CACHE_WRITE_FAILED:${error?.code || "unknown"}`,
      path: file,
    };
  }
}

/**
 * Resolve the advisory project profile, reusing the cache while its source
 * identity is unchanged.
 *
 * @param {string} worktree project root
 * @param {object} [options]
 * @param {boolean} [options.refresh] force a rebuild
 * @param {boolean} [options.write] persist the rebuilt profile (default true)
 * @param {object} [options.telemetry] telemetry provider with `emit`
 * @param {string} [options.runId] run id for telemetry correlation
 * @returns {{ok: boolean, profile: object|null, cache_hit: boolean,
 *   rebuilt: boolean, reason: string, duration_ms: number, path: string|null,
 *   advisory: true}}
 */
export function resolveProjectProfile(worktree, options = {}) {
  const root = safeRoot(worktree);
  const started = Date.now();
  const refresh = options.refresh === true;
  const load = refresh
    ? { ok: false, reason: "REFRESH_REQUESTED", profile: null, path: cacheFile(root) }
    : loadProjectProfile(root);

  let result;
  if (load.ok) {
    result = {
      ok: true,
      profile: load.profile,
      cache_hit: true,
      rebuilt: false,
      reason: load.reason,
      path: load.path,
      cache_written: false,
    };
  } else {
    const profile = buildProjectProfile(root);
    const write =
      options.write === false
        ? { written: false, reason: "WRITE_DISABLED", path: cacheFile(root) }
        : writeProfile(root, profile);
    result = {
      ok: true,
      profile,
      cache_hit: false,
      rebuilt: true,
      reason: load.reason,
      path: write.path,
      cache_written: write.written,
      cache_write_reason: write.reason,
    };
  }

  const duration = Date.now() - started;
  const telemetry = options.telemetry;
  if (typeof telemetry?.emit === "function") {
    telemetry.emit({
      event: "project_profile",
      run_id: options.runId,
      kind: result.cache_hit ? "cache_hit" : "rebuild",
      cache_hit: result.cache_hit,
      project_profile_cache_hit: result.cache_hit ? 1 : 0,
      project_profile_rebuild: result.rebuilt ? 1 : 0,
      project_profile_duration_ms: duration,
      duration_ms: duration,
    });
  }

  return { ...result, duration_ms: duration, advisory: true };
}
