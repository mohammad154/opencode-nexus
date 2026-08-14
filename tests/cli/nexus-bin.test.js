import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bin = path.join(repoRoot, "bin", "nexus.js");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function invoke(args, extraEnv = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

test("nexus version prints the package version", () => {
  const result = invoke(["version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("nexus help lists install update uninstall doctor", () => {
  const result = invoke(["help"]);
  assert.equal(result.status, 0, result.stderr);
  for (const word of ["install", "update", "uninstall", "doctor", "version"]) {
    assert.match(result.stdout, new RegExp(word));
  }
});

test("nexus rejects unknown commands", () => {
  const result = invoke(["not-a-command"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command: not-a-command/);
});

test("nexus doctor reports missing graphify without installing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-doctor-"));
  try {
    const result = invoke(["doctor"], {
      HOME: home,
      OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
      PATH: "/usr/bin:/bin",
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /graphify/);
    assert.match(result.stdout, /plugin not configured|no /);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
