import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sealDirectSelfEdit } from "../scripts/lib/private-baseline.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runCli = path.join(repoRoot, "scripts", "nexus-run.js");

function sentinelEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-seal-cfg-"));
  const globalConfig = path.join(dir, "gitconfig");
  fs.writeFileSync(globalConfig, "# untouched\n");
  return {
    dir,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  };
}

function git(root, env, args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-seal-"));
  const sentinel = sentinelEnv();
  const env = sentinel.env;
  git(root, env, ["init", "-q"]);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(root, "src", "other.js"), "export const other = 1;\n");
  git(root, env, ["add", "-A"]);
  git(root, env, ["commit", "-q", "-m", "nexus-baseline"]);
  return {
    root,
    env,
    base: git(root, env, ["rev-parse", "HEAD"]),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sentinel.dir, { recursive: true, force: true });
    },
  };
}

function committedFiles(repo, commit = "HEAD") {
  return git(repo.root, repo.env, ["show", "--name-only", "--format=", commit])
    .split("\n")
    .filter(Boolean)
    .sort();
}

test("in-scope edit seals only the allowed file", () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, "src", "app.js"), "export const value = 2;\n");
    const sealed = sealDirectSelfEdit(repo.root, {
      allowedFiles: ["src/app.js"],
      env: repo.env,
    });
    assert.equal(sealed.ok, true, sealed.message);
    assert.equal(sealed.committed, true);
    assert.deepEqual(committedFiles(repo), ["src/app.js"]);
    assert.equal(git(repo.root, repo.env, ["log", "-1", "--format=%s"]), "nexus-direct-edit");
  } finally {
    repo.cleanup();
  }
});

test("an out-of-scope change refuses the seal with a scope-drift error and commits nothing", () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, "src", "app.js"), "export const value = 2;\n");
    fs.writeFileSync(path.join(repo.root, "src", "other.js"), "export const other = 2;\n");
    const sealed = sealDirectSelfEdit(repo.root, {
      allowedFiles: ["src/app.js"],
      env: repo.env,
    });
    assert.equal(sealed.ok, false);
    assert.equal(sealed.code, "DIRECT_SCOPE_DRIFT");
    assert.deepEqual(sealed.out_of_scope, ["src/other.js"]);
    assert.deepEqual(sealed.allowed_files, ["src/app.js"]);
    assert.match(sealed.hint, /allowed_files/);
    assert.doesNotMatch(sealed.message, /fatal|pathspec|exited/i);
    assert.equal(git(repo.root, repo.env, ["rev-parse", "HEAD"]), repo.base);
    assert.equal(git(repo.root, repo.env, ["diff", "--cached", "--name-only"]), "");
  } finally {
    repo.cleanup();
  }
});

test("a pre-staged out-of-scope file is refused and never swept into the seal", () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, "src", "app.js"), "export const value = 2;\n");
    fs.writeFileSync(path.join(repo.root, "src", "other.js"), "export const other = 2;\n");
    git(repo.root, repo.env, ["add", "src/other.js"]);
    const sealed = sealDirectSelfEdit(repo.root, {
      allowedFiles: ["src/app.js"],
      env: repo.env,
    });
    assert.equal(sealed.code, "DIRECT_SCOPE_DRIFT");
    assert.equal(git(repo.root, repo.env, ["rev-parse", "HEAD"]), repo.base);
  } finally {
    repo.cleanup();
  }
});

test("an allowed file that does not exist is tolerated and not passed to git", () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo.root, "src", "app.js"), "export const value = 2;\n");
    const sealed = sealDirectSelfEdit(repo.root, {
      allowedFiles: ["src/app.js", "src/missing.js"],
      env: repo.env,
    });
    assert.equal(sealed.ok, true, sealed.message);
    assert.deepEqual(committedFiles(repo), ["src/app.js"]);
  } finally {
    repo.cleanup();
  }
});

test("a deleted in-scope file is committed as a deletion", () => {
  const repo = makeRepo();
  try {
    fs.rmSync(path.join(repo.root, "src", "app.js"));
    const sealed = sealDirectSelfEdit(repo.root, {
      allowedFiles: ["src/app.js"],
      env: repo.env,
    });
    assert.equal(sealed.ok, true, sealed.message);
    assert.equal(git(repo.root, repo.env, ["ls-tree", "HEAD", "src/app.js"]), "");
    assert.deepEqual(committedFiles(repo), ["src/app.js"]);
  } finally {
    repo.cleanup();
  }
});

test("a rename that moves a file out of scope is refused through its old path", () => {
  const repo = makeRepo();
  try {
    git(repo.root, repo.env, ["mv", "src/app.js", "src/renamed.js"]);
    const sealed = sealDirectSelfEdit(repo.root, {
      allowedFiles: ["src/app.js"],
      env: repo.env,
    });
    assert.equal(sealed.code, "DIRECT_SCOPE_DRIFT");
    assert.deepEqual(sealed.out_of_scope, ["src/renamed.js"]);
    assert.equal(git(repo.root, repo.env, ["rev-parse", "HEAD"]), repo.base);
  } finally {
    repo.cleanup();
  }
});

test("no change seals to the current HEAD without creating a commit", () => {
  const repo = makeRepo();
  try {
    const sealed = sealDirectSelfEdit(repo.root, { allowedFiles: ["src/app.js"], env: repo.env });
    assert.equal(sealed.ok, true);
    assert.equal(sealed.committed, false);
    assert.equal(sealed.commit, repo.base);
  } finally {
    repo.cleanup();
  }
});

test("a directory that is not a repository refuses with a coded error, not a raw git error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-seal-norepo-"));
  const sentinel = sentinelEnv();
  try {
    const sealed = sealDirectSelfEdit(dir, { allowedFiles: ["a.js"], env: sentinel.env });
    assert.equal(sealed.ok, false);
    assert.equal(sealed.code, "SEAL_NO_HEAD");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});

test("the CLI refuses an out-of-scope direct edit with DIRECT_SCOPE_DRIFT and recovers after the drift is undone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-direct-scope-cli-"));
  const sentinel = sentinelEnv();
  const env = { ...sentinel.env, NEXUS_WORKTREE: root };
  const run = (args) =>
    spawnSync(process.execPath, [runCli, ...args], { cwd: root, env, encoding: "utf8", timeout: 180000 });
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 1;\n");
    fs.writeFileSync(path.join(root, "src", "other.js"), "export const other = 1;\n");

    const init = run(["init", "--run-id", "scope-cli"]);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(run(["transition", "--run-id", "scope-cli", "--to", "BRAINSTORMING"]).status, 0);
    const implementing = run([
      "transition",
      "--run-id",
      "scope-cli",
      "--to",
      "IMPLEMENTING",
      "--json",
      JSON.stringify({
        session_plan: "Goal: bump the value\nNon-goals: none\nFiles: src/app.js\nCheck: none\nStop: escalate",
        allowed_files: ["src/app.js"],
        acceptance_criteria: ["value is 2"],
      }),
    ]);
    assert.equal(implementing.status, 0, `${implementing.stderr}\n${implementing.stdout}`);

    fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 2;\n");
    fs.writeFileSync(path.join(root, "src", "other.js"), "export const other = 2;\n");
    const refused = run(["transition", "--run-id", "scope-cli", "--to", "VERIFYING"]);
    assert.equal(refused.status, 2, refused.stdout);
    const body = JSON.parse(refused.stderr);
    assert.equal(body.code, "DIRECT_SCOPE_DRIFT");
    assert.deepEqual(body.out_of_scope, ["src/other.js"]);
    assert.match(body.hint, /allowed_files/);
    assert.doesNotMatch(refused.stderr, /fatal:/);

    fs.writeFileSync(path.join(root, "src", "other.js"), "export const other = 1;\n");
    const sealedNow = run(["transition", "--run-id", "scope-cli", "--to", "VERIFYING"]);
    assert.equal(sealedNow.status, 0, `${sealedNow.stderr}\n${sealedNow.stdout}`);
    const subject = spawnSync("git", ["log", "-1", "--format=%s"], { cwd: root, env, encoding: "utf8" });
    assert.equal(subject.stdout.trim(), "nexus-direct-edit");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});
