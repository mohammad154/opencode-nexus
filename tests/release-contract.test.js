import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("CI keeps the full OS and Node matrix plus installer aggregator", () => {
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert.match(ci, new RegExp(os.replaceAll("-", "\\-")));
  }
  for (const node of ['"20"', '"22"', '"lts/*"']) assert.match(ci, new RegExp(node.replace("*", "\\*")));
  assert.match(ci, /name: Installer isolation/);
  assert.match(ci, /name: CI/);
  assert.match(ci, /needs: \[test, install\]/);
});

test("manual release is downstream of green CI, installer, and security checks", () => {
  const release = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  for (const required of ["CI", "Installer isolation", "Plugin Security Scan"]) {
    assert.match(release, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(release, /status !== "completed"/);
  assert.match(release, /conclusion !== "success"/);
  assert.match(release, /npm test/);
  assert.match(release, /npm run test:install/);
  assert.match(release, /npm publish --access public/);
  assert.match(release, /git tag -a/);
  assert.match(release, /gh release create/);
});
