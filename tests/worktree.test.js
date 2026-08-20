import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createTaskWorktree,
  removeTaskWorktree,
  listTaskWorktrees,
  worktreeRoot,
} from "../scripts/lib/worktree.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "nexus.js");
const runScript = path.join(repoRoot, "scripts", "nexus-run.js");

function createTestRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-worktree-test-"));
  const git = (...args) => {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    }
    return (res.stdout || "").trim();
  };

  git("init");
  git("config", "user.email", "nexus@example.com");
  git("config", "user.name", "Nexus Tester");

  fs.writeFileSync(path.join(dir, "file1.txt"), "commit 1\n");
  git("add", "file1.txt");
  git("commit", "-m", "commit 1");
  const commit1 = git("rev-parse", "HEAD");

  fs.writeFileSync(path.join(dir, "file2.txt"), "commit 2\n");
  git("add", "file2.txt");
  git("commit", "-m", "commit 2");
  const commit2 = git("rev-parse", "HEAD");

  return { dir, commit1, commit2, git };
}

function invokeCli(args, cwd) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NEXUS_WORKTREE: cwd },
  });
}

function invokeRunCli(args, cwd) {
  return spawnSync(process.execPath, [runScript, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NEXUS_WORKTREE: cwd },
  });
}

test("createTaskWorktree uses baseCommit when creating new worktree", () => {
  const { dir, commit1, commit2, git } = createTestRepo();
  try {
    assert.notEqual(commit1, commit2);
    const res = createTaskWorktree(dir, "task-base", { baseCommit: commit1 });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.reused, false);
    assert.ok(fs.existsSync(res.path));

    const wtRev = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: res.path,
      encoding: "utf8",
    });
    assert.equal(wtRev.status, 0);
    assert.equal(wtRev.stdout.trim(), commit1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createTaskWorktree respects custom branch and existing branch checkout", () => {
  const { dir, commit1, commit2, git } = createTestRepo();
  try {
    // Custom branch
    const res = createTaskWorktree(dir, "task-custom-branch", {
      branch: "feature-custom",
      baseCommit: commit1,
    });
    assert.equal(res.ok, true);
    assert.equal(res.branch, "feature-custom");

    // Remove worktree directory without deleting branch
    removeTaskWorktree(dir, "task-custom-branch");

    // Create again with existing branch name
    const res2 = createTaskWorktree(dir, "task-custom-branch-2", {
      branch: "feature-custom",
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.branch, "feature-custom");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createTaskWorktree compares trimmed SHA for reused worktrees", () => {
  const { dir, commit1, commit2 } = createTestRepo();
  try {
    const first = createTaskWorktree(dir, "task-reuse", { baseCommit: commit1 });
    assert.equal(first.ok, true);

    // Reusing with matching baseCommit even if whitespace is present in input
    const second = createTaskWorktree(dir, "task-reuse", {
      baseCommit: `  ${commit1}\n`,
    });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.reused, true);
    assert.equal(second.head, commit1);

    // Reusing with a mismatched baseCommit should fail
    const mismatch = createTaskWorktree(dir, "task-reuse", {
      baseCommit: commit2,
    });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error, /!= expected base/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createTaskWorktree fails on dirty worktree reuse", () => {
  const { dir, commit1 } = createTestRepo();
  try {
    const first = createTaskWorktree(dir, "task-dirty", { baseCommit: commit1 });
    assert.equal(first.ok, true);

    fs.writeFileSync(path.join(first.path, "dirty.txt"), "untracked change");

    const second = createTaskWorktree(dir, "task-dirty", { baseCommit: commit1 });
    assert.equal(second.ok, false);
    assert.match(second.error, /dirty/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeTaskWorktree and listTaskWorktrees work correctly", () => {
  const { dir, commit1 } = createTestRepo();
  try {
    // Non-existent worktree returns removed: false
    const noopRem = removeTaskWorktree(dir, "non-existent");
    assert.equal(noopRem.ok, true);
    assert.equal(noopRem.removed, false);

    const res1 = createTaskWorktree(dir, "task-1", { baseCommit: commit1 });
    const res2 = createTaskWorktree(dir, "task-2", { baseCommit: commit1 });
    assert.equal(res1.ok, true);
    assert.equal(res2.ok, true);

    const list = listTaskWorktrees(dir);
    assert.equal(list.length, 2);
    const taskIds = list.map((w) => w.task_id).sort();
    assert.deepEqual(taskIds, ["task-1", "task-2"]);

    const rem = removeTaskWorktree(dir, "task-1");
    assert.equal(rem.ok, true);
    assert.equal(rem.removed, true);

    const listAfter = listTaskWorktrees(dir);
    assert.equal(listAfter.length, 1);
    assert.equal(listAfter[0].task_id, "task-2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI nexus worktree create, list, remove work as expected", () => {
  const { dir, commit1, commit2 } = createTestRepo();
  try {
    // 1. Create worktree
    const createRes = invokeCli(
      ["worktree", "create", "--task", "cli-task", "--base", commit1],
      dir,
    );
    assert.equal(createRes.status, 0, `${createRes.stdout}\n${createRes.stderr}`);
    const created = JSON.parse(createRes.stdout);
    assert.equal(created.ok, true);
    assert.equal(created.reused, false);
    assert.ok(fs.existsSync(created.path));

    // Verify commit in created worktree
    const wtRev = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: created.path,
      encoding: "utf8",
    });
    assert.equal(wtRev.stdout.trim(), commit1);

    // 2. List worktrees
    const listRes = invokeCli(["worktree", "list"], dir);
    assert.equal(listRes.status, 0, `${listRes.stdout}\n${listRes.stderr}`);
    const listPayload = JSON.parse(listRes.stdout);
    assert.equal(listPayload.ok, true);
    assert.equal(Array.isArray(listPayload.worktrees), true);
    assert.equal(listPayload.worktrees.length, 1);
    assert.equal(listPayload.worktrees[0].task_id, "cli-task");

    // 3. Remove worktree
    const removeRes = invokeCli(["worktree", "remove", "--task", "cli-task"], dir);
    assert.equal(removeRes.status, 0, `${removeRes.stdout}\n${removeRes.stderr}`);
    const removePayload = JSON.parse(removeRes.stdout);
    assert.equal(removePayload.ok, true);

    // 4. Verify list is empty
    const listEmptyRes = invokeCli(["worktree", "list"], dir);
    assert.equal(listEmptyRes.status, 0);
    const listEmptyPayload = JSON.parse(listEmptyRes.stdout);
    assert.equal(listEmptyPayload.worktrees.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI nexus run worktree forwards commands correctly", () => {
  const { dir, commit1 } = createTestRepo();
  try {
    const createRes = invokeRunCli(
      ["worktree", "create", "--task", "run-task", "--base", commit1],
      dir,
    );
    assert.equal(createRes.status, 0, `${createRes.stdout}\n${createRes.stderr}`);
    const created = JSON.parse(createRes.stdout);
    assert.equal(created.ok, true);

    const listRes = invokeRunCli(["worktree", "list"], dir);
    assert.equal(listRes.status, 0);
    const listPayload = JSON.parse(listRes.stdout);
    assert.equal(listPayload.worktrees.length, 1);
    assert.equal(listPayload.worktrees[0].task_id, "run-task");

    const removeRes = invokeRunCli(["worktree", "remove", "--task", "run-task"], dir);
    assert.equal(removeRes.status, 0);
    const removePayload = JSON.parse(removeRes.stdout);
    assert.equal(removePayload.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI nexus worktree error handling", () => {
  const { dir } = createTestRepo();
  try {
    // Missing --task on create
    const noTaskCreate = invokeCli(["worktree", "create"], dir);
    assert.notEqual(noTaskCreate.status, 0);
    assert.match(noTaskCreate.stderr + noTaskCreate.stdout, /--task required/);

    // Missing --task on remove
    const noTaskRemove = invokeCli(["worktree", "remove"], dir);
    assert.notEqual(noTaskRemove.status, 0);
    assert.match(noTaskRemove.stderr + noTaskRemove.stdout, /--task required/);

    // Unknown subcommand
    const unknownSub = invokeCli(["worktree", "unknown"], dir);
    assert.notEqual(unknownSub.status, 0);
    assert.match(unknownSub.stderr + unknownSub.stdout, /unknown|Usage/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
