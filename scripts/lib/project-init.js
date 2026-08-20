import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONTEXT = `# Nexus Context

workflow: default
execution_mode: delegated
branch_cleanup_policy: always
`;

const PROJECT_DIRS = [
  ".opencode/plans",
  ".opencode/tasks",
  ".opencode/handoffs",
  ".opencode/runs",
  ".opencode/blast",
  ".opencode/reconcile",
  ".opencode/trajectories",
];

/**
 * Bootstrap Nexus artifacts in a target project worktree.
 * Idempotent: skips CONTEXT.md when it already exists.
 */
export function projectInit(worktree, options = {}) {
  const pkgVersion = options.pkgVersion || "unknown";
  const pkgName = options.pkgName || "@mohammad154/opencode-nexus";
  const pkgRoot = options.pkgRoot || null;

  const createdDirs = [];
  for (const rel of PROJECT_DIRS) {
    const abs = path.join(worktree, rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
      createdDirs.push(rel);
    } else {
      fs.mkdirSync(abs, { recursive: true });
    }
  }

  const contextPath = path.join(worktree, ".opencode", "CONTEXT.md");
  let contextCreated = false;
  if (!fs.existsSync(contextPath)) {
    fs.writeFileSync(contextPath, DEFAULT_CONTEXT);
    contextCreated = true;
  }

  const nexusJsonPath = path.join(worktree, ".opencode", "nexus.json");
  const nexusJson = {
    schema_version: "1.0",
    package: pkgName,
    version: pkgVersion,
    commands: {
      run: "nexus run",
      blast: "nexus blast",
      classify: "nexus classify",
      estimate: "nexus estimate",
      project_init: "nexus project-init",
    },
    pkg_root: pkgRoot,
    initialized_at: new Date().toISOString(),
  };
  fs.writeFileSync(nexusJsonPath, `${JSON.stringify(nexusJson, null, 2)}\n`);

  return {
    ok: true,
    worktree,
    created_dirs: createdDirs,
    context_created: contextCreated,
    context_path: contextPath,
    nexus_json_path: nexusJsonPath,
  };
}

export { PROJECT_DIRS, DEFAULT_CONTEXT };
