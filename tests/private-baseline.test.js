import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  cleanupPrivateBaseline,
  ensurePrivateBaseline,
} from "../scripts/lib/private-baseline.js";
import { checkPlan } from "../scripts/lib/plan-check.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runCli = path.join(repoRoot, "scripts", "nexus-run.js");

function git(cwd, args, env = process.env) {
  return spawnSync("git", args, { cwd, env, encoding: "utf8" });
}

function isolatedEnv(globalConfig) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

const PLAN = `# Plan: cohesive units
- Planning mode: standard
- Plan commit: NO_GIT_REPO

## Goal
Ship the API response and the worker event.

## Non-goals
- No transport redesign.

## Execution Unit Justification
Number of units: 2

Why not fewer:
- The API and worker have separate implementation and acceptance boundaries.

Why not more:
- Tests and setup remain with the behavior they support.

## Execution Unit breakdown
### Execution Unit 1: API response
- id: unit-1
- Depends on: none
- user_outcome: Return the new API response to callers
- independently_shippable: true
- review_boundary: none
- estimated_lines: 120
- Allowed files: \`src/api.js\`
- Evidence:
  - \`src/api.js:1\` current implementation
- Acceptance criteria:
  - [ ] API returns the new response.
- Verification gates:
  1. npm test -- api
- STOP conditions:
  - STOP if \`src/api.js\` is missing.

### Execution Unit 2: Worker event
- id: unit-2
- Depends on: unit-1
- user_outcome: Process the new worker event
- independently_shippable: true
- review_boundary: none
- estimated_lines: 90
- Allowed files: \`src/worker.js\`
- Evidence:
  - \`src/worker.js:1\` current implementation
- Acceptance criteria:
  - [ ] Worker handles the new event.
- Verification gates:
  1. npm test -- worker
- STOP conditions:
  - STOP if \`src/worker.js\` is missing.
`;

test("git-less init creates a local baseline and removes it when the run finishes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gitless-"));
  const globalConfig = path.join(root, "global-gitconfig");
  fs.writeFileSync(globalConfig, "# untouched\n");
  const env = { ...isolatedEnv(globalConfig), NEXUS_WORKTREE: root };
  try {
    const init = spawnSync(process.execPath, [runCli, "init", "--run-id", "gitless"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stderr, /Private git baseline created/);
    assert.equal(fs.existsSync(path.join(root, ".git")), true);
    const name = git(root, ["config", "--local", "user.name"], env);
    const email = git(root, ["config", "--local", "user.email"], env);
    assert.equal(name.stdout.trim(), "Nexus Baseline");
    assert.equal(email.stdout.trim(), "nexus-baseline@localhost");
    assert.equal(fs.readFileSync(globalConfig, "utf8"), "# untouched\n");
    const subject = git(root, ["log", "-1", "--format=%s"], env);
    assert.equal(subject.stdout.trim(), "nexus-baseline");

    const failed = spawnSync(
      process.execPath,
      [
        runCli,
        "transition",
        "--run-id",
        "gitless",
        "--to",
        "FAILED",
        "--json",
        JSON.stringify({ reason: "stop" }),
      ],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.equal(failed.status, 0, `${failed.stderr}\n${failed.stdout}`);
    assert.equal(fs.existsSync(path.join(root, ".git")), false);
    assert.equal(fs.existsSync(path.join(root, ".opencode", "runs", "gitless", "state.json")), true);
    assert.equal(fs.readFileSync(globalConfig, "utf8"), "# untouched\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an existing repository is not rewritten and its .git is not removed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-existing-git-"));
  const globalConfig = path.join(os.tmpdir(), `nexus-global-${process.pid}`);
  fs.writeFileSync(globalConfig, "# sentinel\n");
  const env = isolatedEnv(globalConfig);
  try {
    assert.equal(git(root, ["init"], env).status, 0);
    assert.equal(git(root, ["config", "user.name", "Existing User"], env).status, 0);
    assert.equal(git(root, ["config", "user.email", "existing@example.test"], env).status, 0);
    fs.writeFileSync(path.join(root, "app.js"), "export const app = true;\n");
    assert.equal(git(root, ["add", "app.js"], env).status, 0);
    assert.equal(git(root, ["commit", "-m", "real history"], env).status, 0);
    const before = git(root, ["rev-parse", "HEAD"], env).stdout.trim();

    const baseline = ensurePrivateBaseline(root, { env });
    assert.equal(baseline.created, false);
    assert.equal(baseline.method, "existing-git");
    assert.equal(baseline.message, null);
    assert.equal(git(root, ["rev-parse", "HEAD"], env).stdout.trim(), before);
    assert.equal(git(root, ["config", "--local", "user.name"], env).stdout.trim(), "Existing User");
    assert.equal(fs.readFileSync(globalConfig, "utf8"), "# sentinel\n");

    fs.mkdirSync(path.join(root, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".opencode", "private-baseline.json"),
      JSON.stringify({
        created: true,
        existed_before: false,
        method: "git",
        commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        worktree: root,
      }),
    );
    const cleaned = cleanupPrivateBaseline(root, { env });
    assert.equal(cleaned.removed, false);
    assert.equal(fs.existsSync(path.join(root, ".git")), true);
    assert.equal(git(root, ["rev-parse", "HEAD"], env).stdout.trim(), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(globalConfig, { force: true });
  }
});

test("a missing git binary records a content-hash baseline and plan-check accepts it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hash-"));
  try {
    fs.writeFileSync(path.join(root, "app.js"), "export const app = true;\n");
    const baseline = ensurePrivateBaseline(root, {
      gitBin: path.join(root, "missing-git"),
      runId: "hash-run",
    });
    assert.equal(baseline.ok, true);
    assert.equal(baseline.method, "content-hash");
    assert.equal(fs.existsSync(path.join(root, ".git")), false);
    assert.match(baseline.message, /content-hash baseline/);
    const planDir = path.join(root, ".opencode", "plans");
    fs.mkdirSync(planDir, { recursive: true });
    const planPath = path.join(planDir, "PLAN.md");
    fs.writeFileSync(planPath, PLAN);
    const result = checkPlan(PLAN, { planPath, worktree: root, runId: "hash-run" });
    assert.equal(
      result.errors.some((error) => error.code === "MISSING_PLAN_COMMIT"),
      false,
    );
    assert.equal(result.warnings.some((warning) => warning.code === "PRIVATE_BASELINE_COMMIT"), true);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.match(result.plan_commit, /^content-hash:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
