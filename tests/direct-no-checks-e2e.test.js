import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runCli = path.join(repoRoot, "scripts", "nexus-run.js");
const RUN_ID = "no-checks-e2e";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-no-checks-e2e-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-no-checks-cfg-"));
  const globalConfig = path.join(configDir, "gitconfig");
  fs.writeFileSync(globalConfig, "# untouched\n");
  const env = {
    ...process.env,
    NEXUS_WORKTREE: root,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const run = (args) =>
    spawnSync(process.execPath, [runCli, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 180000,
    });
  const cleanup = () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  };
  return { root, env, globalConfig, run, cleanup };
}

function startDirectRun(ctx) {
  fs.mkdirSync(path.join(ctx.root, "src"));
  fs.writeFileSync(path.join(ctx.root, "src", "app.js"), "export const value = 1;\n");

  const init = ctx.run(["init", "--run-id", RUN_ID]);
  assert.equal(init.status, 0, init.stderr);
  const initialized = JSON.parse(init.stdout);
  assert.equal(initialized.state.fast_path.mode, "direct");
  assert.equal(initialized.state.fast_path.test_suite, false);

  const brainstorm = ctx.run(["transition", "--run-id", RUN_ID, "--to", "BRAINSTORMING"]);
  assert.equal(brainstorm.status, 0, brainstorm.stderr);

  const implementing = ctx.run([
    "transition",
    "--run-id",
    RUN_ID,
    "--to",
    "IMPLEMENTING",
    "--json",
    JSON.stringify({
      session_plan:
        "Goal: bump the value\nNon-goals: no redesign\nFiles: src/app.js\nCheck: none (no test suite)\nStop: escalate",
      allowed_files: ["src/app.js"],
      acceptance_criteria: ["value is 2"],
    }),
  ]);
  assert.equal(implementing.status, 0, `${implementing.stderr}\n${implementing.stdout}`);
  fs.writeFileSync(path.join(ctx.root, "src", "app.js"), "export const value = 2;\n");
}

test("a git-less, test-less direct run reaches COMPLETED through nexus verify", { timeout: 180000 }, () => {
  const ctx = setup();
  try {
    startDirectRun(ctx);

    const verifying = ctx.run(["transition", "--run-id", RUN_ID, "--to", "VERIFYING"]);
    assert.equal(verifying.status, 0, `${verifying.stderr}\n${verifying.stdout}`);
    assert.ok(JSON.parse(verifying.stdout).state.implementer_commit);

    const verified = ctx.run(["verify", "--run-id", RUN_ID, "--json"]);
    assert.equal(verified.status, 0, `${verified.stderr}\n${verified.stdout}`);
    const verifiedBody = JSON.parse(verified.stdout);
    assert.equal(verifiedBody.ok, true);
    assert.equal(verifiedBody.verification.verification_mode, "NO_AUTOMATED_CHECKS");
    assert.equal(verifiedBody.verification.no_automated_checks.ok, true);
    assert.deepEqual(verifiedBody.verification.no_automated_checks.changed_paths, ["src/app.js"]);
    assert.match(verifiedBody.warnings.join("\n"), /No executable check ran/);

    const finalizing = ctx.run(["transition", "--run-id", RUN_ID, "--to", "FINAL_VERIFYING"]);
    assert.equal(finalizing.status, 0, `${finalizing.stderr}\n${finalizing.stdout}`);
    const finalVerified = ctx.run(["verify", "--run-id", RUN_ID, "--json"]);
    assert.equal(finalVerified.status, 0, `${finalVerified.stderr}\n${finalVerified.stdout}`);
    assert.equal(JSON.parse(finalVerified.stdout).verification.verification_mode, "NO_AUTOMATED_CHECKS");

    const completed = ctx.run(["transition", "--run-id", RUN_ID, "--to", "COMPLETED"]);
    assert.equal(completed.status, 0, `${completed.stderr}\n${completed.stdout}`);
    assert.equal(JSON.parse(completed.stdout).state.state, "COMPLETED");
    assert.equal(fs.readFileSync(ctx.globalConfig, "utf8").startsWith("# untouched"), true);
  } finally {
    ctx.cleanup();
  }
});

test("a direct run whose workspace gains a test directory after the seal fails closed", { timeout: 180000 }, () => {
  const ctx = setup();
  try {
    startDirectRun(ctx);
    const verifying = ctx.run(["transition", "--run-id", RUN_ID, "--to", "VERIFYING"]);
    assert.equal(verifying.status, 0, `${verifying.stderr}\n${verifying.stdout}`);

    fs.mkdirSync(path.join(ctx.root, "tests"));
    fs.writeFileSync(path.join(ctx.root, "tests", "app.test.js"), "// added after the seal\n");

    const verified = ctx.run(["verify", "--run-id", RUN_ID, "--json"]);
    assert.notEqual(verified.status, 0, verified.stdout);
    const body = JSON.parse(verified.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.code, "VERIFICATION_UNAVAILABLE");
    assert.equal(body.state.verification_status, "FAILED");
    assert.match(body.error, /test suite/);
  } finally {
    ctx.cleanup();
  }
});

test("a direct run whose sealed file drifts again before verify is refused as scope drift", { timeout: 180000 }, () => {
  const ctx = setup();
  try {
    startDirectRun(ctx);
    const verifying = ctx.run(["transition", "--run-id", RUN_ID, "--to", "VERIFYING"]);
    assert.equal(verifying.status, 0, `${verifying.stderr}\n${verifying.stdout}`);

    fs.writeFileSync(path.join(ctx.root, "src", "app.js"), "export const value = 3;\n");

    const verified = ctx.run(["verify", "--run-id", RUN_ID, "--json"]);
    assert.notEqual(verified.status, 0, verified.stdout);
    const body = JSON.parse(verified.stdout);
    assert.equal(body.code, "DIRECT_SCOPE_DRIFT");
    assert.equal(body.state.verification_status, "FAILED");
  } finally {
    ctx.cleanup();
  }
});
