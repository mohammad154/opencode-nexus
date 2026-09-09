/**
 * Discover verification commands for a worktree.
 * Steps use {command, args} and must be executed with shell:false.
 */
import fs from "fs";
import path from "path";
import { verificationLadder } from "./compare.js";
import {
  isIgnoredPath,
  loadScopePolicy,
  matchingIgnorePattern,
  normalizeRelativePath,
} from "../path-filter.js";

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".bin",
  ".class",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

const TEXT_TARGET_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cjs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);

function isGeneratedPath(rel) {
  const normalized = rel.replace(/\\/g, "/");
  return (
    /(^|\/)(?:generated|generated-files|artifacts)(?:\/|$)/i.test(normalized) ||
    /(^|\/)(?:generated|generated[-_]\w+)[^.\/]*\.[^.\/]+$/i.test(normalized) ||
    /\.(?:generated|gen|min|bundle)\.[^.]+$/i.test(normalized) ||
    /\.(?:map|lock)$/i.test(normalized)
  );
}

function hasCmd(worktree, bin) {
  // Soft check: package scripts or lockfiles imply toolchain presence
  return true;
}

/** Reject path traversal and shell metacharacters in related test paths. */
export function isSafeRelPath(rel) {
  if (!rel || typeof rel !== "string") return false;
  if (rel.includes("\0")) return false;
  const normalized = rel.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
  if (normalized.split("/").includes("..")) return false;
  if (/[;&|`$<>(){}!]/.test(normalized)) return false;
  return true;
}

function targetValue(value) {
  return typeof value === "string" ? value : value?.path || value?.file || "";
}

/**
 * Resolve a candidate verification target to a safe, existing text source.
 * This is intentionally stricter than shell safety: a safe path can still be
 * a runtime artifact, binary, generated file, or missing file.
 */
export function resolveVerificationTarget(worktree, value, options = {}) {
  const raw = targetValue(value);
  if (!isSafeRelPath(raw)) {
    return { ok: false, path: String(raw || ""), reason: "unsafe_path" };
  }
  const rel = normalizeRelativePath(raw);
  if (!rel) return { ok: false, path: raw, reason: "unsafe_path" };
  const policy = options.policy || loadScopePolicy(worktree);
  const ignoredPattern = isIgnoredPath(rel, policy.ignored_patterns)
    ? matchingIgnorePattern(rel, policy.ignored_patterns) || "project_path_policy"
    : null;
  if (ignoredPattern) {
    return { ok: false, path: rel, reason: "ignored", pattern: ignoredPattern };
  }
  if (isGeneratedPath(rel)) {
    return { ok: false, path: rel, reason: "generated_target" };
  }
  const ext = path.extname(rel).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return { ok: false, path: rel, reason: "binary_target" };
  }
  if (!TEXT_TARGET_EXTENSIONS.has(ext)) {
    return { ok: false, path: rel, reason: "unsupported_target" };
  }
  const abs = path.resolve(worktree, rel);
  const root = path.resolve(worktree);
  if (!abs.startsWith(`${root}${path.sep}`) || !fs.existsSync(abs)) {
    return { ok: false, path: rel, reason: "missing_target" };
  }
  try {
    if (!fs.statSync(abs).isFile()) {
      return { ok: false, path: rel, reason: "not_a_file" };
    }
    const sample = fs.readFileSync(abs).subarray(0, 4096);
    if (sample.includes(0)) {
      return { ok: false, path: rel, reason: "binary_target" };
    }
  } catch {
    return { ok: false, path: rel, reason: "unreadable_target" };
  }
  return { ok: true, path: rel };
}

/** Resolve and de-duplicate related/impacted verification targets. */
export function resolveVerificationTargets(worktree, values = [], options = {}) {
  const policy = options.policy || loadScopePolicy(worktree);
  const targets = [];
  const ignored = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const resolved = resolveVerificationTarget(worktree, value, { policy });
    if (!resolved.ok) {
      if (resolved.path) ignored.push(resolved);
      continue;
    }
    if (!seen.has(resolved.path)) {
      seen.add(resolved.path);
      targets.push(resolved.path);
    }
  }
  return { targets, ignored };
}

function targetFromStep(step) {
  if (step?.target) return step.target;
  if (step?.id?.startsWith("related:")) return step.id.slice("related:".length);
  const args = Array.isArray(step?.args) ? step.args : [];
  const marker = args.indexOf("--");
  if (marker >= 0) return args[marker + 1] || "";
  return "";
}

/** Remove invalid targeted steps from caller-supplied or discovered plans. */
export function filterVerificationPlan(worktree, plan = {}) {
  const policy = loadScopePolicy(worktree);
  const steps = [];
  const ignored_targets = Array.isArray(plan.ignored_targets)
    ? [...plan.ignored_targets]
    : [];
  for (const candidate of Array.isArray(plan.steps) ? plan.steps : []) {
    const marker = Array.isArray(candidate?.args)
      ? candidate.args.indexOf("--")
      : -1;
    const explicitArgTarget =
      candidate?.kind === "test" &&
      marker >= 0 &&
      typeof candidate.args[marker + 1] === "string" &&
      !candidate.args[marker + 1].startsWith("-");
    const targeted =
      candidate?.kind === "targeted-test" ||
      candidate?.id?.startsWith("related:") ||
      Boolean(candidate?.target) ||
      explicitArgTarget;
    if (!targeted) {
      steps.push(candidate);
      continue;
    }
    const target = resolveVerificationTarget(worktree, targetFromStep(candidate), {
      policy,
    });
    if (!target.ok) {
      ignored_targets.push(target);
      continue;
    }
    steps.push(candidate);
  }
  return { ...plan, steps, ignored_targets };
}

function step(id, command, args, kind, extra = {}) {
  return { id, command, args: [...args], kind, ...extra };
}

function filterStepsByLadder(steps, options = {}) {
  const risk = options.risk || options.risk_tier;
  if (!risk) return steps;
  const ladder = verificationLadder(risk);
  const levels = new Set(ladder.levels || []);

  return steps.filter((s) => {
    if (s.kind === "targeted-test" || (s.id && s.id.startsWith("related:"))) {
      return levels.has("related_tests");
    }
    if (s.kind === "test" || s.id === "test") {
      return levels.has("full_tests") || ladder.require_full === true;
    }
    if (s.kind === "lint" || s.id === "lint" || s.id === "vet") {
      return levels.has("lint");
    }
    if (s.kind === "typecheck" || s.id === "typecheck" || s.id === "check") {
      return levels.has("typecheck");
    }
    if (s.kind === "build" || s.id === "build") {
      return levels.has("build");
    }
    return true;
  });
}

export function discoverVerification(worktree, options = {}) {
  const steps = [];
  const policy = loadScopePolicy(worktree);
  const relatedResolution = resolveVerificationTargets(
    worktree,
    options.related_tests || [],
    { policy },
  );
  const pkgPath = path.join(worktree, "package.json");
  if (fs.existsSync(pkgPath)) {
    let pkg = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      pkg = {};
    }
    const scripts = pkg.scripts || {};
    if (scripts.test) steps.push(step("test", "npm", ["test"], "test"));
    if (scripts.lint) steps.push(step("lint", "npm", ["run", "lint"], "lint"));
    if (scripts.typecheck) {
      steps.push(step("typecheck", "npm", ["run", "typecheck"], "typecheck"));
    }
    if (scripts.build) {
      steps.push(step("build", "npm", ["run", "build"], "build"));
    }
    for (const rel of relatedResolution.targets) {
      steps.push(
        step(`related:${rel}`, "npm", ["test", "--", rel], "targeted-test"),
      );
    }
    return {
      ecosystem: "node",
      steps: filterStepsByLadder(steps, options),
      related_tests: relatedResolution.targets,
      ignored_targets: relatedResolution.ignored,
    };
  }

  if (
    fs.existsSync(path.join(worktree, "pyproject.toml")) ||
    fs.existsSync(path.join(worktree, "pytest.ini"))
  ) {
    return {
      ecosystem: "python",
      steps: filterStepsByLadder([
        step("test", "pytest", [], "test"),
        step("lint", "ruff", ["check", "."], "lint", { status: "UNAVAILABLE" }),
      ], options),
      related_tests: relatedResolution.targets,
      ignored_targets: relatedResolution.ignored,
    };
  }
  if (fs.existsSync(path.join(worktree, "Cargo.toml"))) {
    return {
      ecosystem: "rust",
      steps: filterStepsByLadder([
        step("test", "cargo", ["test"], "test"),
        step("check", "cargo", ["check"], "typecheck"),
      ], options),
      related_tests: relatedResolution.targets,
      ignored_targets: relatedResolution.ignored,
    };
  }
  if (fs.existsSync(path.join(worktree, "go.mod"))) {
    return {
      ecosystem: "go",
      steps: filterStepsByLadder([
        step("test", "go", ["test", "./..."], "test"),
        step("vet", "go", ["vet", "./..."], "lint"),
      ], options),
      related_tests: relatedResolution.targets,
      ignored_targets: relatedResolution.ignored,
    };
  }

  return {
    ecosystem: "generic",
    steps: [
      step("noop", "true", [], "generic", { status: "UNAVAILABLE" }),
    ],
    related_tests: relatedResolution.targets,
    ignored_targets: relatedResolution.ignored,
  };
}

export { hasCmd };
