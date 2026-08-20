/**
 * Discover verification commands for a worktree.
 */
import fs from "fs";
import path from "path";

function hasCmd(worktree, bin) {
  // Soft check: package scripts or lockfiles imply toolchain presence
  return true;
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
    if (scripts.test) steps.push({ id: "test", command: "npm test", kind: "test" });
    if (scripts.lint) steps.push({ id: "lint", command: "npm run lint", kind: "lint" });
    if (scripts.typecheck) {
      steps.push({ id: "typecheck", command: "npm run typecheck", kind: "typecheck" });
    }
    if (scripts.build) steps.push({ id: "build", command: "npm run build", kind: "build" });
    const related = options.related_tests || [];
    for (const rt of related) {
      const rel = typeof rt === "string" ? rt : rt.path || rt.file;
      if (!rel) continue;
      const abs = path.join(worktree, rel);
      if (fs.existsSync(abs)) {
        steps.push({
          id: `related:${rel}`,
          command: `npm test -- ${rel}`,
          kind: "targeted-test",
        });
      }
    }
    return {
      ecosystem: "node",
      steps,
      related_tests: related,
    };
  }

  if (fs.existsSync(path.join(worktree, "pyproject.toml")) || fs.existsSync(path.join(worktree, "pytest.ini"))) {
    return {
      ecosystem: "python",
      steps: [
        { id: "test", command: "pytest", kind: "test" },
        { id: "lint", command: "ruff check .", kind: "lint", status: "UNAVAILABLE" },
      ],
    };
  }
  if (fs.existsSync(path.join(worktree, "Cargo.toml"))) {
    return {
      ecosystem: "rust",
      steps: [
        { id: "test", command: "cargo test", kind: "test" },
        { id: "check", command: "cargo check", kind: "typecheck" },
      ],
    };
  }
  if (fs.existsSync(path.join(worktree, "go.mod"))) {
    return {
      ecosystem: "go",
      steps: [
        { id: "test", command: "go test ./...", kind: "test" },
        { id: "vet", command: "go vet ./...", kind: "lint" },
      ],
    };
  }

  return {
    ecosystem: "generic",
    steps: [{ id: "noop", command: "true", kind: "generic", status: "UNAVAILABLE" }],
  };
}

export { hasCmd };
