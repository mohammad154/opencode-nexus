import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "nexus.js");

function invoke(args, extraEnv = {}, cwd = repoRoot) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    cwd,
  });
}

function setupTestRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-baseline-test-"));
  spawnSync("git", ["init", "--quiet", root]);
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "test-pkg",
      version: "1.0.0",
      scripts: {
        test: "node -e 'process.exit(0)'",
      },
    }),
  );
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-m", "init", "--quiet"], { cwd: root });
  return root;
}

test("nexus run baseline captures baseline report for an active run", () => {
  const root = setupTestRepo();
  try {
    const initRes = invoke(["run", "init", "--run-id", "test-run-1"], {}, root);
    assert.equal(initRes.status, 0, initRes.stderr);

    const res = invoke(["run", "baseline", "--run-id", "test-run-1"], {}, root);
    assert.equal(res.status, 0, res.stderr);

    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.ok(payload.baseline);
    assert.equal(payload.baseline.schema_version, "1.0");
    assert.ok(Array.isArray(payload.baseline.results));

    const baselineFile = path.join(root, ".opencode", "runs", "test-run-1", "baseline.json");
    assert.ok(fs.existsSync(baselineFile));
    const saved = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
    assert.equal(saved.schema_version, "1.0");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nexus baseline top-level CLI command captures baseline", () => {
  const root = setupTestRepo();
  try {
    invoke(["run", "init", "--run-id", "test-run-2"], {}, root);

    const res = invoke(["baseline", "--run-id", "test-run-2"], {}, root);
    assert.equal(res.status, 0, res.stderr);

    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.ok(payload.baseline);
    assert.equal(payload.baseline.schema_version, "1.0");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nexus verify --baseline captures verification baseline", () => {
  const root = setupTestRepo();
  try {
    invoke(["run", "init", "--run-id", "test-run-3"], {}, root);

    const res = invoke(["verify", "--baseline", "--run-id", "test-run-3"], {}, root);
    assert.equal(res.status, 0, res.stderr);

    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.ok(payload.baseline);
    assert.equal(payload.baseline.schema_version, "1.0");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
