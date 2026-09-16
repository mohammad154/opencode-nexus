import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  validateContainedPath,
  assertContainedPath,
} from "../scripts/lib/filesystem-boundary.js";
import {
  filterPathEntries,
  loadScopePolicy,
  normalizeRelativePath,
} from "../scripts/lib/path-filter.js";
import { assertScopeLock } from "../scripts/lib/scope-lock.js";
import {
  createEmptyRunState,
  latestActiveRunState,
  listRunIds,
  readRunState,
  runStatePath,
  writeRunState,
} from "../scripts/lib/migrate-artifacts.js";
import {
  createTaskWorktree,
  listTaskWorktrees,
  removeTaskWorktree,
} from "../scripts/lib/worktree.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("filesystem guard enforces lexical and canonical containment", (t) => {
  const root = tempDir("nexus-boundary-lexical-");
  const outside = tempDir("nexus-boundary-lexical-outside-");
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const valid = validateContainedPath(root, path.join(root, "runtime", "state.json"));
  assert.equal(valid.ok, true);
  assert.equal(normalizeRelativePath("src/./file.js"), null);

  const traversal = validateContainedPath(root, path.join(root, "..", "outside.js"));
  assert.equal(traversal.ok, false);
  assert.equal(traversal.reason, "outside_root");

  const linked = path.join(root, "src", "linked.js");
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.writeFileSync(path.join(outside, "outside.js"), "outside\n");
  fs.symlinkSync(path.join(outside, "outside.js"), linked);
  const canonicalEscape = validateContainedPath(root, linked);
  assert.equal(canonicalEscape.ok, false);
  assert.equal(canonicalEscape.reason, "outside_root");

  assert.throws(
    () => assertContainedPath(root, `${root}/bad\0path`),
    (error) => error.code === "FILESYSTEM_BOUNDARY",
  );
});

test("unsafe changed paths remain evidence and fail scope lock", () => {
  const unsafe = [
    "../../outside.js",
    "/tmp/outside.js",
    "C:\\outside.js",
    "src/with\0nul.js",
  ];
  const filtered = filterPathEntries(unsafe);
  assert.deepEqual(
    filtered.ignored.map(({ path: file, reason }) => ({ path: file, reason })),
    unsafe.map((file) => ({ path: file, reason: "unsafe_path" })),
  );

  for (const changed of unsafe) {
    const locked = assertScopeLock({
      allowed_files: ["src/**"],
      changed_files: [changed],
    });
    assert.equal(locked.ok, false, changed);
    assert.equal(locked.code, "SCOPE_UNSAFE_PATH", changed);
    assert.deepEqual(locked.extras, [changed]);
    assert.equal(locked.unsafe_files[0].path, changed);
  }
});

test("symlinked runtime roots and changed files fail closed", (t) => {
  const worktree = tempDir("nexus-boundary-runtime-");
  const outside = tempDir("nexus-boundary-runtime-outside-");
  t.after(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(outside, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(outside, "config", "scope-policy.json"),
    JSON.stringify({ allowed: ["outside/**"] }),
  );
  fs.symlinkSync(outside, path.join(worktree, ".opencode"));

  const policy = loadScopePolicy(worktree);
  assert.equal(policy.source, "default-unsafe");
  assert.deepEqual(policy.allowed, [".opencode/**", "src/**", "tests/**", "plan/**"]);

  const rootLock = assertScopeLock({
    worktree,
    allowed_files: ["src/**"],
    changed_files: [],
  });
  assert.equal(rootLock.ok, false);
  assert.equal(rootLock.code, "SCOPE_UNSAFE_PATH");
  assert.equal(rootLock.unsafe_files[0].reason, "symlink_component");

  fs.rmSync(path.join(worktree, ".opencode"));
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(outside, "outside.js"), "outside\n");
  fs.symlinkSync(
    path.join(outside, "outside.js"),
    path.join(worktree, "src", "linked.js"),
  );
  const changedLock = assertScopeLock({
    worktree,
    allowed_files: ["src/**"],
    changed_files: ["src/linked.js"],
  });
  assert.equal(changedLock.ok, false);
  assert.equal(changedLock.code, "SCOPE_UNSAFE_PATH");
  assert.equal(changedLock.unsafe_files[0].reason, "symlink_component");
});

test("active-run and run-state paths cannot follow external symlinks", (t) => {
  const worktree = tempDir("nexus-boundary-active-");
  const outside = tempDir("nexus-boundary-active-outside-");
  t.after(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const written = writeRunState(worktree, createEmptyRunState("inside"));
  const pointer = path.join(worktree, ".opencode", "active-run");
  const outsidePointer = path.join(outside, "active-run");
  fs.writeFileSync(outsidePointer, "outside\n");
  fs.rmSync(pointer);
  fs.symlinkSync(outsidePointer, pointer);

  assert.equal(latestActiveRunState(worktree).run_id, "inside");
  assert.throws(
    () => writeRunState(worktree, { ...written, state: "BRAINSTORMING" }),
    (error) => error.code === "FILESYSTEM_BOUNDARY",
  );
  assert.equal(fs.readFileSync(outsidePointer, "utf8"), "outside\n");

  const externalRunDir = path.join(worktree, ".opencode", "runs", "external");
  fs.rmSync(externalRunDir, { recursive: true, force: true });
  fs.symlinkSync(outside, externalRunDir);
  assert.throws(
    () => runStatePath(worktree, "external"),
    (error) => error.code === "FILESYSTEM_BOUNDARY",
  );
  assert.throws(
    () => readRunState(worktree, "external"),
    (error) => error.code === "FILESYSTEM_BOUNDARY",
  );
  assert.deepEqual(listRunIds(worktree), ["inside"]);
});

test("malformed run entries are ignored without becoming reusable state", (t) => {
  const worktree = tempDir("nexus-boundary-runs-");
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));

  writeRunState(worktree, createEmptyRunState("valid-run"));
  const malformed = path.join(worktree, ".opencode", "runs", "malformed");
  fs.mkdirSync(malformed, { recursive: true });
  fs.writeFileSync(path.join(malformed, "state.json"), "{}\n");
  fs.writeFileSync(path.join(worktree, ".opencode", "active-run"), "malformed\n");

  assert.deepEqual(listRunIds(worktree), ["valid-run"]);
  assert.equal(latestActiveRunState(worktree).run_id, "valid-run");
});

function createGitRepo() {
  const dir = tempDir("nexus-boundary-worktree-");
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init");
  git("config", "user.name", "Boundary Test");
  git("config", "user.email", "boundary@example.com");
  fs.writeFileSync(path.join(dir, "README.md"), "boundary\n");
  git("add", ".");
  git("commit", "-m", "base");
  const head = git("rev-parse", "HEAD").trim();
  return { dir, head };
}

test("malformed worktree paths are not reused, listed, or removed", (t) => {
  const { dir } = createGitRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const malformed = path.join(dir, ".opencode", "worktrees", "bad-task");
  fs.mkdirSync(malformed, { recursive: true });
  fs.writeFileSync(path.join(malformed, "not-a-worktree"), "user data\n");

  const reused = createTaskWorktree(dir, "bad-task");
  assert.equal(reused.ok, false);
  assert.equal(reused.code, "INVALID_WORKTREE");
  assert.deepEqual(listTaskWorktrees(dir), []);

  const removed = removeTaskWorktree(dir, "bad-task");
  assert.equal(removed.ok, false);
  assert.equal(removed.removed, false);
  assert.ok(fs.existsSync(path.join(malformed, "not-a-worktree")));
});

test("normal runtime and task worktree paths remain usable", (t) => {
  const { dir, head } = createGitRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const state = writeRunState(dir, createEmptyRunState("normal-run"));
  assert.equal(state.run_id, "normal-run");
  assert.equal(listRunIds(dir)[0], "normal-run");

  const created = createTaskWorktree(dir, "normal-task", { baseCommit: head });
  assert.equal(created.ok, true, created.error);
  assert.equal(listTaskWorktrees(dir).length, 1);
  assert.equal(listTaskWorktrees(dir)[0].task_id, "normal-task");
});
