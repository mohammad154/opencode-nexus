import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectInit } from "../../scripts/lib/project-init.js";
import { buildRunGateReminder } from "../../scripts/lib/run-gate.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bin = path.join(repoRoot, "bin", "nexus.js");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function invoke(args, extraEnv = {}, cwd = repoRoot) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    cwd,
  });
}

test("nexus version prints the package version", () => {
  const result = invoke(["version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("nexus help lists workflow commands", () => {
  const result = invoke(["help"]);
  assert.equal(result.status, 0, result.stderr);
  for (const word of [
    "install",
    "update",
    "uninstall",
    "doctor",
    "version",
    "project-init",
    "next",
    "run",
    "impact",
    "blast",
    "classify",
    "estimate",
    "worktree",
  ]) {
    assert.match(result.stdout, new RegExp(word));
  }
});

test("nexus run help documents subcommands", () => {
  const result = invoke(["run", "help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /init/);
  assert.match(result.stdout, /next/);
  assert.match(result.stdout, /transition/);
  assert.match(result.stdout, /validate-handoff/);
});

test("nexus rejects unknown commands", () => {
  const result = invoke(["not-a-command"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command: not-a-command/);
});

test("nexus doctor reports impact-engine without requiring graphify", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-doctor-"));
  try {
    const result = invoke(
      ["doctor"],
      {
        HOME: home,
        OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
        PATH: "/usr/bin:/bin",
      },
      home,
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /impact-engine/);
    assert.doesNotMatch(result.stdout, /\bok\s+graphify\b/);
    assert.match(result.stdout, /plugin not configured|no /);
    assert.match(result.stdout, /CLI path:/);
    assert.match(result.stdout, new RegExp(`Nexus ${pkg.version}`));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("nexus project-init bootstraps an external repo", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-project-init-"));
  try {
    const result = invoke(["project-init"], {}, root);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.ok(fs.existsSync(path.join(root, ".opencode", "CONTEXT.md")));
    assert.ok(fs.existsSync(path.join(root, ".opencode", "nexus.json")));
    assert.ok(fs.existsSync(path.join(root, ".opencode", "plans")));
    assert.ok(fs.existsSync(path.join(root, ".opencode", "handoffs")));

    const again = projectInit(root, {
      pkgVersion: pkg.version,
      pkgName: pkg.name,
      pkgRoot: repoRoot,
    });
    assert.equal(again.context_created, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nexus run forwards init to package script from external repo", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-run-forward-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-run-home-"));
  try {
    invoke(["project-init"], {}, root);
    spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
    spawnSync("git", ["config", "user.email", "nexus@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Nexus CLI"], { cwd: root });
    fs.writeFileSync(path.join(root, "README.md"), "# fixture\n");
    spawnSync("git", ["add", "README.md"], { cwd: root });
    spawnSync("git", ["commit", "-m", "init"], { cwd: root });

    const result = invoke(["run", "init", "--run-id", "cli-forward"], { HOME: home }, root);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.state.state, "CREATED");
    assert.ok(
      fs.existsSync(path.join(root, ".opencode", "runs", "cli-forward", "state.json")),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("buildRunGateReminder warns when no active run", () => {
  const text = buildRunGateReminder(null);
  assert.match(text, /No active Nexus run/);
  assert.match(text, /nexus project-init/);
});

test("buildRunGateReminder enforces dispatch during IMPLEMENTING", () => {
  const text = buildRunGateReminder({
    state: "IMPLEMENTING",
    run_id: "demo",
  });
  assert.match(text, /IMPLEMENTING/);
  assert.match(text, /Dispatch implementer/);
});
