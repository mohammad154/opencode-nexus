/**
 * Discover verification commands for a worktree.
 * Steps use {command, args} and must be executed with shell:false.
 */
import fs from "fs";
import path from "path";
import { verificationLadder } from "./compare.js";

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
    const related = options.related_tests || [];
    for (const rt of related) {
      const rel = typeof rt === "string" ? rt : rt.path || rt.file;
      if (!rel || !isSafeRelPath(rel)) continue;
      const abs = path.join(worktree, rel);
      if (fs.existsSync(abs)) {
        steps.push(
          step(`related:${rel}`, "npm", ["test", "--", rel], "targeted-test"),
        );
      }
    }
    return {
      ecosystem: "node",
      steps: filterStepsByLadder(steps, options),
      related_tests: related,
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
      related_tests: options.related_tests || [],
    };
  }
  if (fs.existsSync(path.join(worktree, "Cargo.toml"))) {
    return {
      ecosystem: "rust",
      steps: filterStepsByLadder([
        step("test", "cargo", ["test"], "test"),
        step("check", "cargo", ["check"], "typecheck"),
      ], options),
      related_tests: options.related_tests || [],
    };
  }
  if (fs.existsSync(path.join(worktree, "go.mod"))) {
    return {
      ecosystem: "go",
      steps: filterStepsByLadder([
        step("test", "go", ["test", "./..."], "test"),
        step("vet", "go", ["vet", "./..."], "lint"),
      ], options),
      related_tests: options.related_tests || [],
    };
  }

  return {
    ecosystem: "generic",
    steps: [
      step("noop", "true", [], "generic", { status: "UNAVAILABLE" }),
    ],
    related_tests: options.related_tests || [],
  };
}

export { hasCmd };

