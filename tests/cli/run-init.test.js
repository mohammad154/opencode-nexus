import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runCli = path.join(repoRoot, "scripts", "nexus-run.js");

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-runinit-"));
  spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  return root;
}

function invoke(worktree, args) {
  return spawnSync(process.execPath, [runCli, ...args], {
    cwd: worktree,
    encoding: "utf8",
    env: { ...process.env, NEXUS_WORKTREE: worktree },
  });
}

test("default run id is unique across two same-day inits", (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = JSON.parse(invoke(root, ["init"]).stdout);
  const b = JSON.parse(invoke(root, ["init"]).stdout);
  assert.notEqual(a.state.run_id, b.state.run_id);
  assert.match(a.state.run_id, /^run-\d{4}-\d{2}-\d{2}T/);
});

test("nexus run init refuses to overwrite an existing run without --force", (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = invoke(root, ["init", "--run-id", "dup"]);
  assert.equal(first.status, 0, first.stderr);

  const second = invoke(root, ["init", "--run-id", "dup"]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists/);

  const forced = invoke(root, ["init", "--run-id", "dup", "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
});
