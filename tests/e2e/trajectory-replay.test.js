import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readTrajectory, replayTrajectory } from "../../scripts/lib/trajectory.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runCli = path.join(repoRoot, "scripts", "nexus-run.js");
const temporaryRoots = [];

function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-replay-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-replay-home-"));
  temporaryRoots.push(root, home);
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "graphify"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(home, "bin", "graphify"), 0o755);
  const git = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  return { root, home };
}

function invoke(worktree, home, args) {
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
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function invokeFailure(worktree, home, args) {
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
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

test("a failed run can be replayed from its trajectory artifact", () => {
  const { root, home } = makeTempRepo();
  const runId = "replay-failed";
  const trajectoryPath = path.join(root, ".opencode", "trajectories", `${runId}.jsonl`);

  const initialized = invoke(root, home, ["init", "--run-id", runId]);
  assert.equal(readTrajectory(trajectoryPath).length, 1);

  invokeFailure(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "IMPLEMENTING",
  ]);

  const failed = invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "FAILED",
    "--json",
    JSON.stringify({ reason: "simulated implementation failure" }),
  ]);

  const events = readTrajectory(trajectoryPath);
  assert.equal(events.length, 3);
  assert.equal(events.at(-1).state.state, "FAILED");
  assert.equal(events[1].observation.ok, false);

  const replayed = replayTrajectory(trajectoryPath);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.run_id, runId);
  assert.equal(replayed.steps, 3);
  assert.equal(replayed.failed, true);
  assert.equal(replayed.state.state, "FAILED");
});
