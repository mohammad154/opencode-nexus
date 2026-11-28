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
  sealDirectSelfEdit,
} from "../scripts/lib/private-baseline.js";
import { protectedRunDir } from "../scripts/lib/protected-state.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runCli = path.join(repoRoot, "scripts", "nexus-run.js");
process.env.NEXUS_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "nexus-r3-state-"));

function sentinelEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-r3-cfg-"));
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

function git(root, env, args, identity = ["-c", "user.name=Existing User", "-c", "user.email=existing@example.test"]) {
  const result = spawnSync("git", [...identity, ...args], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function writeFiles(root, files) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

function readExclude(root) {
  const file = path.join(root, ".git", "info", "exclude");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

function userRepo(env, files = { "src/app.js": "export const value = 1;\n" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-r3-user-"));
  git(root, env, ["init", "-q"]);
  writeFiles(root, files);
  git(root, env, ["add", "-A"]);
  git(root, env, ["commit", "-q", "-m", "real history"]);
  return root;
}

function privateRepo(env, runId, files = { "src/app.js": "export const value = 1;\n" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-r3-private-"));
  writeFiles(root, files);
  const baseline = ensurePrivateBaseline(root, { runId, env });
  assert.equal(baseline.ok, true, baseline.message);
  assert.equal(baseline.created, true);
  return root;
}

function cli(root, env, args) {
  return spawnSync(process.execPath, [runCli, ...args], {
    cwd: root,
    env: { ...env, NEXUS_WORKTREE: root },
    encoding: "utf8",
    timeout: 180000,
  });
}

test("a user repository with history is never sealed or committed onto by direct mode", () => {
  const sentinel = sentinelEnv();
  const env = sentinel.env;
  const root = userRepo(env);
  try {
    git(root, env, ["add", "-A"]);
    writeFiles(root, { "notes.txt": "staged by the user\n" });
    git(root, env, ["add", "notes.txt"]);
    writeFiles(root, { "src/app.js": "export const value = 2;\n" });
    const head = git(root, env, ["rev-parse", "HEAD"]);
    const excludeBefore = readExclude(root);

    const sealed = sealDirectSelfEdit(root, { runId: "user-repo", allowedFiles: ["src/app.js"], env });

    assert.equal(sealed.ok, false);
    assert.equal(sealed.code, "SEAL_NOT_PRIVATE");
    assert.equal(git(root, env, ["rev-parse", "HEAD"]), head);
    assert.equal(git(root, env, ["diff", "--cached", "--name-only"]), "notes.txt");
    assert.equal(git(root, env, ["log", "-1", "--format=%s"]), "real history");
    assert.equal(readExclude(root), excludeBefore);
    assert.equal(fs.existsSync(path.join(root, ".git", "nexus-empty-hooks")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});

test("init in a user repository with history stays standard and never touches its .git", () => {
  const sentinel = sentinelEnv();
  const env = sentinel.env;
  const root = userRepo(env);
  try {
    const head = git(root, env, ["rev-parse", "HEAD"]);
    const excludeBefore = readExclude(root);
    const init = cli(root, env, ["init", "--run-id", "user-history"]);
    assert.equal(init.status, 0, init.stderr);
    const state = JSON.parse(init.stdout).state;
    assert.equal(state.fast_path.mode, "standard");
    assert.ok(state.fast_path.reasons.includes("EXISTING_GIT_REPOSITORY"));
    assert.equal(git(root, env, ["rev-parse", "HEAD"]), head);
    assert.equal(readExclude(root), excludeBefore);
    assert.equal(fs.existsSync(path.join(root, ".git", "nexus-empty-hooks")), false);

    const failed = cli(root, env, ["transition", "--run-id", "user-history", "--to", "FAILED", "--json", '{"reason":"stop"}']);
    assert.equal(failed.status, 0, `${failed.stderr}\n${failed.stdout}`);
    assert.equal(fs.existsSync(path.join(root, ".git")), true, "a user repository is never removed");
    assert.equal(git(root, env, ["rev-parse", "HEAD"]), head);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});

test("an existing repository with no commits is never direct and keeps its .git", () => {
  const sentinel = sentinelEnv();
  const env = sentinel.env;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-r3-empty-"));
  try {
    git(root, env, ["init", "-q"]);
    writeFiles(root, { "src/app.js": "export const value = 1;\n" });
    const init = cli(root, env, ["init", "--run-id", "empty-repo"]);
    assert.equal(init.status, 0, init.stderr);
    const state = JSON.parse(init.stdout).state;
    assert.equal(state.fast_path.mode, "standard");
    assert.ok(state.fast_path.reasons.includes("EXISTING_GIT_REPOSITORY"));
    assert.equal(state.private_baseline.method, "existing-git");
    const failed = cli(root, env, ["transition", "--run-id", "empty-repo", "--to", "FAILED", "--json", '{"reason":"stop"}']);
    assert.equal(failed.status, 0, `${failed.stderr}\n${failed.stdout}`);
    assert.equal(fs.existsSync(path.join(root, ".git")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});

test("a private baseline seal leaves info/exclude and the hooks directory untouched", () => {
  const sentinel = sentinelEnv();
  const env = sentinel.env;
  const runId = "private-seal-clean";
  const root = privateRepo(env, runId);
  try {
    const excludeBefore = readExclude(root);
    writeFiles(root, { "src/app.js": "export const value = 2;\n" });
    const sealed = sealDirectSelfEdit(root, { runId, allowedFiles: ["src/app.js"], env });
    assert.equal(sealed.ok, true, sealed.message);
    assert.equal(sealed.committed, true);
    assert.equal(readExclude(root), excludeBefore);
    assert.equal(fs.existsSync(path.join(root, ".git", "nexus-empty-hooks")), false);
    assert.deepEqual(git(root, env, ["show", "--name-only", "--format=", "HEAD"]).split("\n"), ["src/app.js"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(protectedRunDir(root, runId), { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});

test("a tracked file under dist/ that the run did not declare is refused by the seal", () => {
  const sentinel = sentinelEnv();
  const env = sentinel.env;
  const runId = "dist-scope";
  const root = privateRepo(env, runId, {
    "src/app.js": "export const value = 1;\n",
    "dist/bundle.js": "built = 1;\n",
  });
  try {
    writeFiles(root, { "src/app.js": "export const value = 2;\n", "dist/bundle.js": "built = 2;\n" });
    const sealed = sealDirectSelfEdit(root, { runId, allowedFiles: ["src/app.js"], env });
    assert.equal(sealed.code, "DIRECT_SCOPE_DRIFT");
    assert.deepEqual(sealed.out_of_scope, ["dist/bundle.js"]);
    assert.equal(git(root, env, ["diff", "--cached", "--name-only"]), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(protectedRunDir(root, runId), { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});

test("a new file under build/ is out of scope and refused by the seal", () => {
  const sentinel = sentinelEnv();
  const env = sentinel.env;
  const runId = "build-scope";
  const root = privateRepo(env, runId);
  try {
    writeFiles(root, { "build/out.js": "output\n" });
    const sealed = sealDirectSelfEdit(root, { runId, allowedFiles: ["src/app.js"], env });
    assert.equal(sealed.code, "DIRECT_SCOPE_DRIFT");
    assert.deepEqual(sealed.out_of_scope, ["build/out.js"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(protectedRunDir(root, runId), { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});

test("cleanup removes the baseline and every direct-edit seal this run made", () => {
  const sentinel = sentinelEnv();
  const env = sentinel.env;
  const runId = "owned-chain";
  const root = privateRepo(env, runId);
  try {
    writeFiles(root, { "src/app.js": "export const value = 2;\n" });
    assert.equal(sealDirectSelfEdit(root, { runId, allowedFiles: ["src/app.js"], env }).ok, true);
    writeFiles(root, { "src/app.js": "export const value = 3;\n" });
    assert.equal(sealDirectSelfEdit(root, { runId, allowedFiles: ["src/app.js"], env }).ok, true);

    const cleaned = cleanupPrivateBaseline(root, { runId, env });
    assert.equal(cleaned.removed, true, cleaned.reason);
    assert.equal(cleaned.kept, false);
    assert.equal(fs.existsSync(path.join(root, ".git")), false);
    assert.equal(fs.existsSync(path.join(protectedRunDir(root, runId), "private-baseline.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(protectedRunDir(root, runId), { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});

test("cleanup keeps .git when this run created a branch", () => {
  const sentinel = sentinelEnv();
  const env = sentinel.env;
  const runId = "extra-branch";
  const root = privateRepo(env, runId);
  try {
    git(root, env, ["branch", "feature"]);
    const cleaned = cleanupPrivateBaseline(root, { runId, env });
    assert.equal(cleaned.removed, false);
    assert.equal(cleaned.kept, true);
    assert.equal(cleaned.reason, "extra-refs");
    assert.equal(fs.existsSync(path.join(root, ".git")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(protectedRunDir(root, runId), { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});

test("cleanup keeps .git when a worktree was added", () => {
  const sentinel = sentinelEnv();
  const env = sentinel.env;
  const runId = "extra-worktree";
  const root = privateRepo(env, runId);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-r3-wt-"));
  fs.rmSync(worktree, { recursive: true, force: true });
  try {
    git(root, env, ["worktree", "add", "--detach", worktree]);
    const cleaned = cleanupPrivateBaseline(root, { runId, env });
    assert.equal(cleaned.removed, false);
    assert.equal(cleaned.reason, "extra-worktrees");
    assert.equal(fs.existsSync(path.join(root, ".git")), true);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(protectedRunDir(root, runId), { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});

test("cleanup keeps .git when a non-Nexus commit landed after the seal", () => {
  const sentinel = sentinelEnv();
  const env = sentinel.env;
  const runId = "foreign-commit";
  const root = privateRepo(env, runId);
  try {
    writeFiles(root, { "src/app.js": "export const value = 2;\n" });
    assert.equal(sealDirectSelfEdit(root, { runId, allowedFiles: ["src/app.js"], env }).ok, true);
    git(root, env, ["commit", "--allow-empty", "-m", "my work"], ["-c", "user.name=Me", "-c", "user.email=me@example.test"]);
    const cleaned = cleanupPrivateBaseline(root, { runId, env });
    assert.equal(cleaned.removed, false);
    assert.equal(cleaned.kept, true);
    assert.equal(fs.existsSync(path.join(root, ".git")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(protectedRunDir(root, runId), { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});

test("a Nexus-authored commit that is not the recorded seal keeps .git", () => {
  const sentinel = sentinelEnv();
  const env = sentinel.env;
  const runId = "forged-seal";
  const root = privateRepo(env, runId);
  try {
    git(
      root,
      env,
      ["commit", "--allow-empty", "-m", "nexus-direct-edit"],
      ["-c", "user.name=Nexus Baseline", "-c", "user.email=nexus-baseline@localhost"],
    );
    const cleaned = cleanupPrivateBaseline(root, { runId, env });
    assert.equal(cleaned.removed, false);
    assert.equal(cleaned.kept, true);
    assert.equal(cleaned.reason, "head-moved");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(protectedRunDir(root, runId), { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});

test("a marker forged inside the project tree never removes a user repository", () => {
  const sentinel = sentinelEnv();
  const env = sentinel.env;
  const root = userRepo(env);
  try {
    const head = git(root, env, ["rev-parse", "HEAD"]);
    const markerDir = path.join(root, ".opencode", "runs", "forged");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, "private-baseline.json"),
      JSON.stringify({ created: true, existed_before: false, method: "git", run_id: "forged", commit: head, worktree: root }),
    );
    const cleaned = cleanupPrivateBaseline(root, { runId: "forged", env });
    assert.equal(cleaned.removed, false);
    assert.equal(cleaned.reason, "not-created-here");
    assert.equal(fs.existsSync(path.join(root, ".git")), true);
    assert.equal(git(root, env, ["rev-parse", "HEAD"]), head);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sentinel.dir, { recursive: true, force: true });
  }
});

test("a content-hash baseline snapshot is removed with its run record", () => {
  const runId = "hash-cleanup";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-r3-hash-"));
  try {
    writeFiles(root, { "app.js": "export const app = true;\n" });
    const baseline = ensurePrivateBaseline(root, { gitBin: path.join(root, "missing-git"), runId });
    assert.equal(baseline.method, "content-hash");
    const snapshot = path.join(protectedRunDir(root, runId), "content-hash.json");
    assert.equal(fs.existsSync(snapshot), true);
    const cleaned = cleanupPrivateBaseline(root, { runId });
    assert.equal(cleaned.reason, "not-a-git-baseline");
    assert.equal(fs.existsSync(snapshot), false);
    assert.equal(fs.existsSync(path.join(root, ".opencode")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(protectedRunDir(root, runId), { recursive: true, force: true });
  }
});
