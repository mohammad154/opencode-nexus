/**
 * Install-time proof that orchestrator state writes match absolute paths
 * and that implementer control-plane denies actually fire.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentPermission,
  evaluatePermissionRules,
} from "./permission-match.js";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

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
 * @param {{ agentDir?: string, probeRoot?: string }} [options]
 * @returns {{ ok: boolean, errors: string[], probe?: string }}
 */
export function runPermissionSelfTest(options = {}) {
  const agentDir = options.agentDir || path.join(PACKAGE_ROOT, "agents");
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
  expectAction(
    errors,
    "python version",
    orchestratorBash("python3 --version"),
    "allow",
  );
  expectAction(
    errors,
    "git commit denied",
    orchestratorBash("git commit -m nexus-baseline"),
    "deny",
  );
  expectAction(
    errors,
    "git commit amend denied",
    orchestratorBash("git commit --amend -m rewrite"),
    "deny",
  );
  expectAction(
    errors,
    "cat redirect denied",
    orchestratorBash("cat file > src/main.py"),
    "deny",
  );
  expectAction(
    errors,
    "find delete denied",
    orchestratorBash("find . -delete"),
    "deny",
  );
  expectAction(
    errors,
    "find exec denied",
    orchestratorBash("find . -exec rm -rf {} +"),
    "deny",
  );
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
    "git checkout branch",
    orchestratorBash("git checkout -b feature"),
    "allow",
  );
  expectAction(
    errors,
    "git checkout discard",
    orchestratorBash("git checkout -- secrets.env"),
    "ask",
  );
  expectAction(errors, "destructive shell", orchestratorBash("rm -rf /"), "deny");

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const probeRoot =
    options.probeRoot || fs.mkdtempSync(path.join(os.tmpdir(), "nexus-perm-"));
  const ownProbe = !options.probeRoot;
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
