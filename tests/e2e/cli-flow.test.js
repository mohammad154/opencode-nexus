import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runCli = path.join(repoRoot, "scripts", "nexus-run.js");
const temporaryRoots = [];

function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-e2e-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-"));
  temporaryRoots.push(root, home);
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "graphify"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(home, "bin", "graphify"), 0o755);
  const git = spawnSync("git", ["init", "--quiet", root], {
    encoding: "utf8",
  });
  assert.equal(git.status, 0, git.stderr);
  spawnSync("git", ["config", "user.email", "nexus@example.com"], {
    cwd: root,
  });
  spawnSync("git", ["config", "user.name", "Nexus E2E"], { cwd: root });
  return { root, home };
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function invoke(worktree, home, args, { expectStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [runCli, ...args], {
    cwd: worktree,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      NEXUS_WORKTREE: worktree,
      PATH: `${path.join(home, "bin")}:${process.env.PATH || ""}`,
    },
  });
  assert.equal(
    result.status,
    expectStatus,
    `${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  const out = (result.stdout || result.stderr || "").trim();
  if (!out) return null;
  try {
    return JSON.parse(
      result.status === 0 ? result.stdout : result.stderr || result.stdout,
    );
  } catch {
    return { raw: out };
  }
}

function json(value) {
  return JSON.stringify(value);
}

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

test("nexus-run completes a full CLI workflow in a temporary repository", () => {
  const { root, home } = makeTempRepo();
  const runId = "e2e-complete";

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "app.js"),
    "export function hello() { return 1; }\n",
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    json({
      name: "e2e-fixture",
      type: "module",
      scripts: { test: "node -e 'process.exit(0)'" },
    }) + "\n",
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  const baseHead = git(root, ["rev-parse", "HEAD"]);

  fs.writeFileSync(
    path.join(root, "src", "app.js"),
    "export function hello() { return 2; }\n",
  );

  const initialized = invoke(root, home, ["init", "--run-id", runId]);
  assert.equal(initialized.state.state, "CREATED");
  assert.equal(initialized.state.workflow, "default");

  invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "BRAINSTORMING",
  ]);
  invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "PLANNED",
    "--plan-skip",
  ]);

  const impactReady = invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "TASK_IMPACT_READY",
    "--json",
    json({
      planned_targets: ["src/app.js"],
      impact_verification: {
        verified: true,
        method: "e2e-fixture",
        reason: "provider impact may be UNKNOWN on tiny fixture",
      },
    }),
  ]);
  assert.equal(impactReady.state.state, "TASK_IMPACT_READY");

  git(root, ["checkout", "-b", "e2e/complete"]);
  const implementing = invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "IMPLEMENTING",
    "--json",
    json({
      branch: "e2e/complete",
      allowed_files: ["src/app.js"],
      acceptance_criteria: ["the CLI flow reaches COMPLETED"],
      current_unit: "e2e-unit",
      drift: {
        schema_version: "1.0",
        drift: "NONE",
        reasons: [],
        plan_commit: baseHead,
        current_head: baseHead,
        commit_distance: 0,
        anchors_broken: [],
        merge_base_changed: false,
      },
    }),
  ]);
  assert.equal(implementing.state.state, "IMPLEMENTING");
  assert.equal(implementing.state.head_commit, baseHead);

  git(root, ["add", "src/app.js"]);
  git(root, ["commit", "-m", "implement hello bump"]);
  const implCommit = git(root, ["rev-parse", "HEAD"]);
  assert.notEqual(implCommit, baseHead);

  const implementer = {
    schema_version: "1.1",
    run_id: runId,
    unit_or_task: "e2e-unit",
    agent: "implementer",
    base_commit: baseHead,
    created_at: new Date().toISOString(),
    status: "DONE",
    commit: implCommit,
    files_changed: ["src/app.js"],
    allowed_files: ["src/app.js"],
    tests: [],
    verification_gates: [{ id: "unit", cmd: "npm test", pass: true }],
    drift_check: {
      plan_commit: baseHead,
      current_head: implCommit,
      pass: true,
    },
    impact: { risk: "LOW", verified: true, callers_checked: [] },
    notes_for_reviewer: "e2e",
  };

  const statePath = path.join(root, ".opencode", "runs", runId, "state.json");
  const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
  st.current_unit = "e2e-unit";
  fs.writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");

  invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "VERIFYING",
    "--json",
    json({ implementer_handoff: implementer }),
  ]);
  invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "REVIEWING",
    "--json",
    json({}),
  ]);

  const reviewHandoff = {
    schema_version: "1.1",
    run_id: runId,
    unit_or_task: "e2e-unit",
    agent: "reviewer",
    base_commit: baseHead,
    created_at: new Date().toISOString(),
    verdict: "APPROVED",
    reviewed_commit: implCommit,
    impact: { pass: true, risk: "LOW" },
    findings: [],
    acceptance: [],
  };

  invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "FINAL_VERIFYING",
    "--json",
    json({ review_handoff: reviewHandoff }),
  ]);

  const completed = invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "COMPLETED",
    "--json",
    json({ review_handoff: reviewHandoff }),
  ]);
  assert.equal(completed.state.state, "COMPLETED");
  assert.equal(completed.state.implementer_commit, implCommit);

  const status = invoke(root, home, ["status", "--run-id", runId]);
  assert.equal(status.state.state, "COMPLETED");
  assert.equal(status.state.transitions.at(-1).to, "COMPLETED");
});

test("CLASSIFIED and DIRECT_IMPLEMENTING are rejected in V5 CLI", () => {
  const { root, home } = makeTempRepo();
  fs.writeFileSync(path.join(root, "README.md"), "# fixture\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);

  invoke(root, home, ["init", "--run-id", "e2e-direct-deny"]);
  const denied = invoke(
    root,
    home,
    [
      "transition",
      "--run-id",
      "e2e-direct-deny",
      "--to",
      "CLASSIFIED",
      "--json",
      json({ classification: { profile: "fast" } }),
    ],
    { expectStatus: 3 },
  );
  assert.equal(denied.ok, false);
});

test("nexus CLI run forwards workflow in an external temporary repository", () => {
  const { root, home } = makeTempRepo();
  const bin = path.join(repoRoot, "bin", "nexus.js");
  const runId = "e2e-nexus-cli";

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "app.js"),
    "export function hello() { return 1; }\n",
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    json({ name: "e2e-nexus-cli", type: "module" }) + "\n",
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  const baseHead = git(root, ["rev-parse", "HEAD"]);
  fs.writeFileSync(
    path.join(root, "src", "app.js"),
    "export function hello() { return 2; }\n",
  );

  const projectInit = spawnSync(process.execPath, [bin, "project-init"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(projectInit.status, 0, projectInit.stderr);

  function nexus(args, { expectStatus = 0 } = {}) {
    const result = spawnSync(process.execPath, [bin, "run", ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NEXUS_WORKTREE: root,
        PATH: `${path.join(home, "bin")}:${process.env.PATH || ""}`,
      },
    });
    assert.equal(
      result.status,
      expectStatus,
      `${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const out = (result.stdout || result.stderr || "").trim();
    if (!out) return null;
    try {
      return JSON.parse(result.status === 0 ? result.stdout : result.stderr || result.stdout);
    } catch {
      return { raw: out };
    }
  }

  const initialized = nexus(["init", "--run-id", runId]);
  assert.equal(initialized.state.state, "CREATED");

  nexus(["transition", "--run-id", runId, "--to", "BRAINSTORMING"]);
  nexus(["transition", "--run-id", runId, "--to", "PLANNED", "--plan-skip"]);
  const impactReady = nexus([
    "transition",
    "--run-id",
    runId,
    "--to",
    "TASK_IMPACT_READY",
    "--json",
    json({
      planned_targets: ["src/app.js"],
      impact_verification: {
        verified: true,
        method: "e2e-nexus-cli",
        reason: "provider impact may be UNKNOWN on tiny fixture",
      },
    }),
  ]);
  assert.equal(impactReady.state.state, "TASK_IMPACT_READY");

  git(root, ["checkout", "-b", "e2e/nexus-cli"]);
  const implementing = nexus([
    "transition",
    "--run-id",
    runId,
    "--to",
    "IMPLEMENTING",
    "--json",
    json({
      branch: "e2e/nexus-cli",
      allowed_files: ["src/app.js"],
      acceptance_criteria: ["CLI forwarded to IMPLEMENTING"],
      drift: {
        schema_version: "1.0",
        drift: "NONE",
        reasons: [],
        plan_commit: baseHead,
        current_head: baseHead,
        commit_distance: 0,
        anchors_broken: [],
        merge_base_changed: false,
      },
    }),
  ]);
  assert.equal(implementing.state.state, "IMPLEMENTING");
});
