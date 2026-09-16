import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverTestFiles,
  runTests,
} from "../scripts/nexus-test-runner.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("test script delegates to the cross-platform runner", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );

  assert.equal(pkg.scripts.test, "node scripts/nexus-test-runner.js");
  assert.doesNotMatch(pkg.scripts.test, /[*?\[\]]/);
});

test("runner discovers nested tests and passes paths as argv items", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus test runner "));
  const testRoot = path.join(root, "tests");
  const nestedRoot = path.join(testRoot, "nested folder");
  fs.mkdirSync(nestedRoot, { recursive: true });
  fs.writeFileSync(
    path.join(testRoot, "root.test.js"),
    'const test = require("node:test");\ntest("root fixture", () => {});\n',
  );
  fs.writeFileSync(
    path.join(nestedRoot, "nested.test.js"),
    'const test = require("node:test");\ntest("nested fixture", () => {});\n',
  );
  fs.writeFileSync(path.join(nestedRoot, "ignored.js"), "this is not a test\n");

  try {
    const files = discoverTestFiles(testRoot);
    assert.deepEqual(files, [
      path.join(nestedRoot, "nested.test.js"),
      path.join(testRoot, "root.test.js"),
    ]);

    const result = runTests({
      projectRoot: root,
      testRoot,
      stdio: "ignore",
    });
    assert.equal(result.status, 0);
    assert.equal(result.error, null);
    assert.equal(result.signal, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runner package allowlist includes only the matching top-level script pattern", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  assert.ok(pkg.files.includes("scripts/nexus-*.js"));
  assert.ok(!pkg.files.includes("scripts/"));
  assert.ok(!pkg.files.includes("scripts/**/*.js"));
});
