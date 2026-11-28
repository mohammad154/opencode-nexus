import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runCli = path.join(repoRoot, "scripts", "nexus-run.js");

function run(root, args, env) {
  return spawnSync(process.execPath, [runCli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 180000,
  });
}

test("direct mode reaches COMPLETED through nexus verify", { timeout: 180000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-direct-e2e-"));
  const globalConfig = path.join(root, "global-gitconfig");
  fs.writeFileSync(globalConfig, "# untouched\n");
  const env = {
    ...process.env,
    NEXUS_WORKTREE: root,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  try {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "direct-e2e",
        private: true,
        scripts: { test: "node -e \"process.exit(0)\"" },
      }),
    );
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 1;\n");

    const init = run(root, ["init", "--run-id", "direct-e2e"], env);
    assert.equal(init.status, 0, init.stderr);
    const initialized = JSON.parse(init.stdout);
    assert.equal(initialized.state.fast_path.mode, "direct");

    const brainstorm = run(root, ["transition", "--run-id", "direct-e2e", "--to", "BRAINSTORMING"], env);
    assert.equal(brainstorm.status, 0, brainstorm.stderr);

    const implementing = run(
      root,
      [
        "transition",
        "--run-id",
        "direct-e2e",
        "--to",
        "IMPLEMENTING",
        "--json",
        JSON.stringify({
          session_plan: "Goal: bump the value\nNon-goals: no redesign\nFiles: src/app.js\nCheck: npm test\nStop: escalate",
          allowed_files: ["src/app.js"],
          acceptance_criteria: ["value is 2"],
        }),
      ],
      env,
    );
    assert.equal(implementing.status, 0, `${implementing.stderr}\n${implementing.stdout}`);
    fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 2;\n");

    const verifying = run(root, ["transition", "--run-id", "direct-e2e", "--to", "VERIFYING"], env);
    assert.equal(verifying.status, 0, `${verifying.stderr}\n${verifying.stdout}`);
    const verifyingState = JSON.parse(verifying.stdout).state;
    assert.ok(verifyingState.implementer_commit);
    const subject = spawnSync("git", ["log", "-1", "--format=%s"], { cwd: root, env, encoding: "utf8" });
    assert.equal(subject.stdout.trim(), "nexus-direct-edit");

    const verified = run(root, ["verify", "--run-id", "direct-e2e"], env);
    assert.equal(verified.status, 0, `${verified.stderr}\n${verified.stdout}`);
    assert.match(verified.stdout, /PASSED/);

    const finalizing = run(root, ["transition", "--run-id", "direct-e2e", "--to", "FINAL_VERIFYING"], env);
    assert.equal(finalizing.status, 0, `${finalizing.stderr}\n${finalizing.stdout}`);
    const finalVerified = run(root, ["verify", "--run-id", "direct-e2e"], env);
    assert.equal(finalVerified.status, 0, `${finalVerified.stderr}\n${finalVerified.stdout}`);

    const completed = run(root, ["transition", "--run-id", "direct-e2e", "--to", "COMPLETED"], env);
    assert.equal(completed.status, 0, `${completed.stderr}\n${completed.stdout}`);
    assert.equal(JSON.parse(completed.stdout).state.state, "COMPLETED");
    assert.equal(fs.existsSync(path.join(root, ".git")), true);
    assert.equal(fs.readFileSync(globalConfig, "utf8").startsWith("# untouched"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
