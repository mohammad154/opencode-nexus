/**
 * Install-time proof that orchestrator state writes match absolute paths,
 * that implementer control-plane denies actually fire, that every agent file
 * parses without duplicate keys, and that the orchestrator's OpenCode bash
 * rules agree with the plugin's command checker on the probe table below.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentPermission,
  evaluatePermissionRules,
  parseAgentFrontmatter,
} from "./permission-match.js";
import { assessOrchestratorBash } from "./orchestrator-bash.js";
import { assessImplementerBash } from "./orchestrator-edit.js";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * [command, plugin decision, whether the OpenCode bash rules must agree].
 * OpenCode matches whole-command patterns, so compound commands and
 * path-dependent checks are decided by the plugin alone.
 */
export const ORCHESTRATOR_BASH_PROBES = [
  ["ls -la /app", "allow", true],
  ["ls", "allow", true],
  ["cat README.md", "allow", true],
  ["head -n 5 README.md", "allow", true],
  ["wc -l README.md", "allow", true],
  ["rg needle src", "allow", true],
  ["grep -rn needle src", "allow", true],
  ["find . -name '*.js' -newer package.json", "allow", true],
  ["find . -delete", "deny", false],
  ["find . -exec rm -rf {} +", "deny", false],
  ["find . -execdir rm {} ;", "deny", false],
  ["find . -name x -ok rm {} +", "deny", false],
  ["find . -okdir rm {} ;", "deny", false],
  ["find . -fprint /tmp/out", "deny", false],
  ["find . -fprint0 /tmp/out", "deny", false],
  ["find . -fprintf /tmp/out %p", "deny", false],
  ["find . -fls /tmp/out", "deny", false],
  ["rg --pre cat needle", "deny", false],
  ["rg needle --pre-glob '*.gz' src", "deny", false],
  ["grep --pre=cat needle src", "deny", false],
  ["git status", "allow", true],
  ["git diff --stat", "allow", true],
  ["git diff --output=/tmp/x", "deny", false],
  ["git log --output=/tmp/x", "deny", false],
  ["git diff --ext-diff", "deny", false],
  ["git -c core.pager=sh status", "deny", false],
  ["git -C .. status", "deny", false],
  ["git symbolic-ref HEAD", "allow", true],
  ["git symbolic-ref --short HEAD", "allow", true],
  ["git symbolic-ref HEAD refs/heads/evil", "deny", false],
  ["git symbolic-ref -d HEAD", "deny", false],
  ["git worktree list", "allow", true],
  ["git worktree add ../lane", "ask", true],
  ["git worktree remove ../lane", "ask", true],
  ["git worktree prune", "ask", true],
  ["git branch -a", "allow", true],
  ["git branch --show-current", "allow", true],
  ["git branch --merged main", "allow", true],
  ["git branch -d feature", "deny", false],
  ["git branch -dr origin/feature", "deny", false],
  ["git branch -D feature", "deny", false],
  ["git branch newbranch", "deny", false],
  ["git branch -u origin/x", "ask", true],
  ["git checkout -b feature", "allow", true],
  ["git checkout -- secrets.env", "ask", true],
  ["git checkout -p", "ask", true],
  ["git checkout -f main", "deny", false],
  ["git checkout -fb x", "deny", false],
  ["git checkout -B main", "deny", false],
  ["git merge feature/x", "allow", true],
  ["git push origin feature", "ask", true],
  ["git reset --hard", "ask", true],
  ["git clean -fd", "ask", true],
  ["git commit -m nexus-baseline", "deny", false],
  ["git commit --amend -m rewrite", "deny", false],
  ["git config core.pager sh", "deny", false],
  ["git add .", "deny", false],
  ["git init", "deny", false],
  ["npm test", "allow", true],
  ["npm run test:unit", "allow", true],
  ["npm run build", "allow", true],
  ["npm install left-pad", "deny", false],
  ["python3 --version", "allow", true],
  ["python3 -c 'import os'", "deny", false],
  ["bash scripts/nexus-branch-cleanup.sh --dry-run", "allow", true],
  ["bash scripts/nexus-branch-cleanup.sh --force-discard x", "ask", true],
  ["bash -c 'rm -rf x'", "deny", false],
  ["cat file > src/main.py", "deny", false],
  ["cat file >> src/main.py", "deny", false],
  ["cat < /etc/passwd", "deny", false],
  ["git status 2>/dev/null", "deny", false],
  ["rm -rf /", "deny", false],
  ["sed -i s/a/b/ file", "deny", false],
  ["awk 'BEGIN{system(\"id\")}'", "deny", false],
  ["git log | tee /tmp/x", "deny", false],
  ["ls | xargs rm", "deny", false],
  ["ls $(whoami)", "deny", false],
  ["ls `whoami`", "deny", false],
  ["FOO=1 git status", "deny", false],
  ["ls && rm -rf x", "deny", false],
  ["ls ;", "deny", false],
  ["ls\nrm -rf x", "deny", false],
  ["less /etc/passwd", "deny", false],
  ["more /etc/passwd", "deny", false],
  ["echo hi", "deny", false],
  ["./scripts/evil.sh", "deny", false],
];

function loadAgent(agentDir, name) {
  const file = path.join(agentDir, `${name}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`permission self-test: missing agent file ${file}`);
  }
  return agentPermission(fs.readFileSync(file, "utf8"));
}

function expectAction(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label}: expected ${expected}, got ${actual}`);
  }
}

/**
 * Every agent file must parse with unique keys. OpenCode drops frontmatter it
 * cannot parse and then applies its default permissions, so a duplicate key is
 * a control-plane failure rather than a style problem.
 */
export function agentFrontmatterErrors(agentDir) {
  const errors = [];
  const files = fs.readdirSync(agentDir).filter((name) => name.endsWith(".md")).sort();
  for (const name of files) {
    try {
      parseAgentFrontmatter(fs.readFileSync(path.join(agentDir, name), "utf8"));
    } catch (error) {
      errors.push(`agent ${name} frontmatter is invalid: ${error.message}`);
    }
  }
  return errors;
}

function bashProbeErrors(orchestratorBashRules, probeWorktree) {
  const errors = [];
  for (const [command, expected, parity] of ORCHESTRATOR_BASH_PROBES) {
    const plugin = assessOrchestratorBash(command, { worktree: probeWorktree });
    const pluginAction = plugin.ok ? plugin.action : "deny";
    if (pluginAction !== expected) {
      errors.push(`orchestrator bash plugin for ${JSON.stringify(command)}: expected ${expected}, got ${pluginAction}`);
    }
    if (parity) {
      const opencode = evaluatePermissionRules(orchestratorBashRules, command);
      if (opencode !== expected) {
        errors.push(`orchestrator bash OpenCode rule for ${JSON.stringify(command)}: expected ${expected}, got ${opencode}`);
      }
    }
  }
  return errors;
}

/**
 * @param {{ agentDir?: string, probeRoot?: string }} [options]
 * @returns {{ ok: boolean, errors: string[], probe?: string }}
 */
export function runPermissionSelfTest(options = {}) {
  const agentDir = options.agentDir || path.join(PACKAGE_ROOT, "agents");
  const frontmatterErrors = agentFrontmatterErrors(agentDir);
  if (frontmatterErrors.length > 0) {
    return { ok: false, errors: frontmatterErrors };
  }
  const errors = [];
  const orchestrator = loadAgent(agentDir, "orchestrator");
  const implementer = loadAgent(agentDir, "implementer");
  const reviewer = loadAgent(agentDir, "reviewer");

  const orchestratorEdit = (value) =>
    evaluatePermissionRules(orchestrator.edit, value);
  const implementerEdit = (value) =>
    evaluatePermissionRules(implementer.edit, value);
  const reviewerEdit = (value) => evaluatePermissionRules(reviewer.edit, value);
  const orchestratorBash = (value) =>
    evaluatePermissionRules(orchestrator.bash, value);
  const external = (rules, value) =>
    evaluatePermissionRules(rules.external_directory, value);

  expectAction(
    errors,
    "orchestrator absolute plan write",
    orchestratorEdit("/app/.opencode/plans/PLAN.md"),
    "allow",
  );
  expectAction(
    errors,
    "orchestrator Windows plan write",
    orchestratorEdit("C:\\app\\.opencode\\plans\\PLAN.md"),
    "allow",
  );
  expectAction(
    errors,
    "orchestrator relative plan write",
    orchestratorEdit(".opencode/plans/PLAN.md"),
    "allow",
  );
  expectAction(
    errors,
    "orchestrator AGENTS.md",
    orchestratorEdit("/app/AGENTS.md"),
    "allow",
  );
  expectAction(
    errors,
    "orchestrator production edit",
    orchestratorEdit("/app/src/app.js"),
    "ask",
  );
  expectAction(
    errors,
    "implementer absolute runs deny",
    implementerEdit("/app/.opencode/runs/state.json"),
    "deny",
  );
  expectAction(
    errors,
    "implementer relative runs deny",
    implementerEdit(".opencode/runs/state.json"),
    "deny",
  );
  expectAction(
    errors,
    "implementer absolute plans deny",
    implementerEdit("/app/.opencode/plans/PLAN.md"),
    "deny",
  );
  expectAction(
    errors,
    "implementer absolute handoff allow",
    implementerEdit("/app/.opencode/handoffs/unit-implementer.json"),
    "allow",
  );
  expectAction(
    errors,
    "implementer production edit",
    implementerEdit("/app/src/app.js"),
    "allow",
  );
  expectAction(
    errors,
    "reviewer absolute handoff allow",
    reviewerEdit("/app/.opencode/handoffs/unit-reviewer.json"),
    "allow",
  );
  expectAction(
    errors,
    "reviewer production edit",
    reviewerEdit("/app/src/app.js"),
    "deny",
  );

  const packagePaths = [
    "/home/user/.local/lib/node_modules/@mohammad154/opencode-nexus/package.json",
    "/root/.nvm/versions/node/v22.21.0/lib/node_modules/@mohammad154/opencode-nexus/schemas/run-state.schema.json",
    "/usr/local/lib/node_modules/@mohammad154/opencode-nexus/schemas/run-state.schema.json",
  ];
  for (const packagePath of packagePaths) {
    expectAction(
      errors,
      `orchestrator external_directory ${packagePath}`,
      external(orchestrator, packagePath),
      "allow",
    );
  }
  expectAction(
    errors,
    "orchestrator expanded cache path",
    external(
      orchestrator,
      "/home/user/.cache/opencode/packages/@mohammad154/opencode-nexus/package.json",
    ),
    "allow",
  );

  expectAction(errors, "ls probe", orchestratorBash("ls -la /app"), "allow");
  expectAction(errors, "bare ls", orchestratorBash("ls"), "allow");
  expectAction(errors, "destructive shell", orchestratorBash("rm -rf /"), "deny");
  expectAction(
    errors,
    "top-level relative edit is ask",
    orchestratorEdit("main.py"),
    "ask",
  );
  expectAction(
    errors,
    "double-dot filename is not traversal",
    orchestratorEdit("foo..bar.js"),
    "ask",
  );
  expectAction(
    errors,
    "orchestrator runs deny",
    orchestratorEdit("/app/.opencode/runs/run-1/state.json"),
    "deny",
  );
  expectAction(
    errors,
    "implementer control-plane bash deny",
    implementerBashDecision("cat ~/.local/state/nexus-control/worktrees/x"),
    "deny",
  );
  expectAction(
    errors,
    "unknown edit floor is ask",
    orchestratorEdit("/app/unknown/notes.txt"),
    "ask",
  );

  const probeRoot = options.probeRoot || fs.mkdtempSync(path.join(os.tmpdir(), "nexus-perm-"));
  const ownProbe = !options.probeRoot;
  errors.push(...bashProbeErrors(orchestrator.bash, probeRoot));
  if (errors.length > 0) {
    if (ownProbe) fs.rmSync(probeRoot, { recursive: true, force: true });
    return { ok: false, errors };
  }

  const planFile = path.join(probeRoot, ".opencode", "plans", "PLAN.md");
  const decision = orchestratorEdit(planFile);
  if (decision !== "allow") {
    if (ownProbe) fs.rmSync(probeRoot, { recursive: true, force: true });
    return {
      ok: false,
      errors: [
        `orchestrator write self-test refused ${planFile} (${decision}). Absolute .opencode paths must be allowed or the orchestrator cannot persist its own state.`,
      ],
    };
  }
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, "nexus permission self-test\n", "utf8");
  const written = fs.readFileSync(planFile, "utf8");
  if (ownProbe) fs.rmSync(probeRoot, { recursive: true, force: true });
  if (!written.includes("nexus permission self-test")) {
    return {
      ok: false,
      errors: ["orchestrator write self-test did not read back the probe file"],
    };
  }
  return { ok: true, errors: [], probe: planFile };
}

function implementerBashDecision(command) {
  return assessImplementerBash(command, { env: {} }).ok ? "allow" : "deny";
}
