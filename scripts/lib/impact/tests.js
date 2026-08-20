/**
 * Related test discovery from changed files / symbols.
 */
import fs from "fs";
import path from "path";

function isTestPath(p) {
  const n = p.replace(/\\/g, "/");
  return (
    /(^|\/)tests?\//.test(n) ||
    /(^|\/)__tests__\//.test(n) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(n)
  );
}

function stem(filePath) {
  const base = path.basename(filePath).replace(/\.(test|spec)\.[^.]+$/, "");
  return base.replace(/\.[^.]+$/, "");
}

export function discoverRelatedTests(worktree, { changed_files = [], direct_dependents = [] } = {}) {
  const related = new Set();
  const candidates = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (["node_modules", ".git", "graphify-out", ".opencode"].includes(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        const rel = path.relative(worktree, full).replace(/\\/g, "/");
        if (isTestPath(rel)) candidates.push(rel);
      }
    }
  }
  walk(worktree);

  const changedStems = new Set(
    [...changed_files.map((f) => (typeof f === "string" ? f : f.path)), ...direct_dependents]
      .filter(Boolean)
      .map(stem),
  );

  for (const testFile of candidates) {
    const tStem = stem(testFile);
    if (changedStems.has(tStem)) {
      related.add(testFile);
      continue;
    }
    // Same directory heuristic: tests/foo mirrors scripts/lib/foo
    for (const changed of changed_files) {
      const p = typeof changed === "string" ? changed : changed.path;
      if (!p) continue;
      if (testFile.includes(stem(p)) || testFile.includes(path.basename(p, path.extname(p)))) {
        related.add(testFile);
      }
    }
  }

  // Include changed test files themselves
  for (const f of changed_files) {
    const p = typeof f === "string" ? f : f.path;
    if (p && isTestPath(p)) related.add(p);
  }

  return [...related].sort();
}

export function discoverAffectedPackages(worktree, changed_files = []) {
  const packages = new Set();
  if (fs.existsSync(path.join(worktree, "package.json"))) {
    packages.add(".");
  }
  for (const f of changed_files) {
    const p = typeof f === "string" ? f : f.path;
    if (!p) continue;
    const parts = p.split("/");
    // packages/foo or apps/bar
    if ((parts[0] === "packages" || parts[0] === "apps") && parts[1]) {
      packages.add(`${parts[0]}/${parts[1]}`);
    }
  }
  return [...packages].sort();
}
