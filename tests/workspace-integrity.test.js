import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inspectWorkspace } from "../scripts/lib/workspace-integrity.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(worktree, ...args) {
  return execFileSync("git", args, {
    cwd: worktree,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createGitRepo(t, prefix) {
  const worktree = tempDir(prefix);
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  git(worktree, "init");
  git(worktree, "config", "user.name", "Workspace Integrity Test");
  git(worktree, "config", "user.email", "workspace-integrity@example.com");
  fs.writeFileSync(path.join(worktree, "README.md"), "workspace integrity\n");
  git(worktree, "add", "README.md");
  git(worktree, "commit", "-m", "base");
  return worktree;
}

function commitAll(worktree, message) {
  git(worktree, "add", "--all");
  git(worktree, "commit", "-m", message);
}

test("internal tracked source symlinks are measured as link metadata", (t) => {
  const worktree = createGitRepo(t, "nexus-workspace-integrity-internal-");
  fs.mkdirSync(path.join(worktree, "configs"));
  fs.writeFileSync(path.join(worktree, "configs", "v2.json"), '{"version":2}\n');
  fs.mkdirSync(path.join(worktree, "src"));
  fs.symlinkSync("../configs/v2.json", path.join(worktree, "src", "current-config"));
  commitAll(worktree, "add internal source symlink");

  const result = inspectWorkspace(worktree);
  assert.equal(result.available, true, result.error);
  assert.equal(result.clean, true);
  assert.match(result.workspace_digest, /^sha256:[a-f0-9]{64}$/);
});

test("external-target tracked source symlinks are accepted without dereferencing", (t) => {
  const worktree = createGitRepo(t, "nexus-workspace-integrity-external-");
  const outside = tempDir("nexus-workspace-integrity-external-target-");
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "target.txt"), "outside-v1\n");
  fs.symlinkSync(
    path.join(outside, "target.txt"),
    path.join(worktree, "external-target.txt"),
  );
  commitAll(worktree, "add external source symlink");

  const before = inspectWorkspace(worktree);
  assert.equal(before.available, true, before.error);
  assert.equal(before.clean, true);

  // If measurement followed the target, this unrelated external edit would
  // change the repository digest. The target is intentionally never opened.
  fs.writeFileSync(path.join(outside, "target.txt"), "outside-v2\n");
  const after = inspectWorkspace(worktree);
  assert.equal(after.available, true, after.error);
  assert.equal(after.workspace_digest, before.workspace_digest);
});

test("dangling tracked source symlinks are accepted as link metadata", (t) => {
  const worktree = createGitRepo(t, "nexus-workspace-integrity-dangling-");
  fs.symlinkSync("missing/config.json", path.join(worktree, "dangling-config"));
  commitAll(worktree, "add dangling source symlink");

  const result = inspectWorkspace(worktree);
  assert.equal(result.available, true, result.error);
  assert.equal(result.clean, true);
  assert.match(result.workspace_digest, /^sha256:[a-f0-9]{64}$/);
});

test("internal runtime symlinks from npm are accepted", (t) => {
  const worktree = createGitRepo(
    t,
    "nexus-workspace-integrity-runtime-internal-",
  );
  const packageBin = path.join(
    worktree,
    ".opencode",
    "node_modules",
    "example-package",
    "bin",
  );
  const npmBin = path.join(worktree, ".opencode", "node_modules", ".bin");
  fs.mkdirSync(packageBin, { recursive: true });
  fs.mkdirSync(npmBin, { recursive: true });
  fs.writeFileSync(path.join(packageBin, "example.js"), "#!/usr/bin/env node\n");
  fs.symlinkSync(
    "../example-package/bin/example.js",
    path.join(npmBin, "example"),
  );

  const result = inspectWorkspace(worktree);
  assert.equal(result.available, true, result.error);
  assert.equal(result.clean, true);
  assert.match(result.workspace_digest, /^sha256:[a-f0-9]{64}$/);
});

test("internal runtime symlink directories are traversed without cycles", (t) => {
  const worktree = createGitRepo(
    t,
    "nexus-workspace-integrity-runtime-directory-link-",
  );
  const nodeModules = path.join(worktree, ".opencode", "node_modules");
  const target = path.join(nodeModules, "shared-runtime");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "package.json"), "{}\n");
  fs.symlinkSync("shared-runtime", path.join(nodeModules, "linked-runtime"));
  fs.symlinkSync("../shared-runtime", path.join(target, "cycle"));

  const result = inspectWorkspace(worktree);
  assert.equal(result.available, true, result.error);
  assert.equal(result.clean, true);
  assert.match(result.workspace_digest, /^sha256:[a-f0-9]{64}$/);
});

test("external and dangling nested runtime symlinks still fail closed", (t) => {
  for (const [label, targetFactory] of [
    ["external", () => {
      const outside = tempDir("nexus-workspace-integrity-nested-outside-");
      t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
      const target = path.join(outside, "tool.js");
      fs.writeFileSync(target, "outside\n");
      return target;
    }],
    ["dangling", () => {
      const outside = tempDir("nexus-workspace-integrity-nested-missing-");
      t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
      return path.join(outside, "tool.js");
    }],
  ]) {
    const worktree = createGitRepo(
      t,
      `nexus-workspace-integrity-nested-${label}-`,
    );
    const npmBin = path.join(worktree, ".opencode", "node_modules", ".bin");
    fs.mkdirSync(npmBin, { recursive: true });
    fs.symlinkSync(targetFactory(), path.join(npmBin, "tool"));

    const result = inspectWorkspace(worktree);
    assert.equal(result.available, false);
    assert.match(result.error, /runtime path measurement failed/i);
    assert.match(result.error, /outside_root|missing_path|symlink|unavailable/i);
  }
});

test("external and dangling runtime symlinks under .opencode fail closed", (t) => {
  for (const [label, targetFactory] of [
    ["external", () => {
      const outside = tempDir("nexus-workspace-integrity-runtime-outside-");
      t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
      return outside;
    }],
    ["dangling", () => {
      const outside = tempDir("nexus-workspace-integrity-runtime-missing-");
      t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
      return path.join(outside, "missing");
    }],
  ]) {
    const worktree = createGitRepo(t, `nexus-workspace-integrity-runtime-${label}-`);
    const target = targetFactory();
    fs.symlinkSync(target, path.join(worktree, ".opencode"));

    const result = inspectWorkspace(worktree);
    assert.equal(result.available, false);
    assert.match(result.error, /runtime path measurement failed/i);
    assert.match(result.error, /symlink|unavailable|boundary/i);
  }
});
