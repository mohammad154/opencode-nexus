import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import { analyzeImpact } from "../scripts/lib/impact/analyze.js";
import { computeConfidence } from "../scripts/lib/impact/confidence.js";

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-impact-conf-"));
  spawnSync("git", ["init", "--quiet", root]);
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  return root;
}

test("unsupported language is counted only once for changed files", () => {
  const root = tempRepo();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "app.py"), "def run():\n  return 1\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-m", "init", "--quiet"], { cwd: root });

    fs.writeFileSync(path.join(root, "src", "app.py"), "def run():\n  return 2\n");
    const report = analyzeImpact(root, { base: "HEAD" });
    assert.equal(report.ok, true);
    // 1 changed file which is unsupported (Python)
    // computeConfidence: score = 1.0 - Math.min(0.4, (1/1)*0.5) - (0 parse errors) = 0.60
    assert.equal(report.confidence, 0.6);
    assert.equal(report.analysis_quality, "CONSERVATIVE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unrelated unsupported files in repo do not reduce confidence for JS changes", () => {
  const root = tempRepo();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "main.js"), "export function main() { return 1; }\n");
    fs.writeFileSync(path.join(root, "src", "script.py"), "def foo(): pass\n");
    fs.writeFileSync(path.join(root, "src", "lib.rs"), "pub fn bar() {}\n");
    fs.writeFileSync(path.join(root, "src", "service.go"), "package main\n");
    fs.writeFileSync(path.join(root, "src", "App.java"), "public class App {}\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-m", "init", "--quiet"], { cwd: root });

    // Modify only the JS file
    fs.writeFileSync(path.join(root, "src", "main.js"), "export function main() { return 2; }\n");
    const report = analyzeImpact(root, { base: "HEAD" });
    assert.equal(report.ok, true);
    assert.equal(report.confidence, 1);
    assert.equal(report.verification_mode, "targeted");
    assert.equal(report.analysis_quality, "PRECISE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mixed changes calculate confidence proportionally without repo-wide parse error leakage", () => {
  const root = tempRepo();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "main.js"), "export function main() { return 1; }\n");
    fs.writeFileSync(path.join(root, "src", "script.py"), "def foo(): pass\n");
    fs.writeFileSync(path.join(root, "src", "lib.rs"), "pub fn bar() {}\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-m", "init", "--quiet"], { cwd: root });

    // Modify 1 JS file and 1 Python file (total 2 files, 1 unsupported)
    fs.writeFileSync(path.join(root, "src", "main.js"), "export function main() { return 2; }\n");
    fs.writeFileSync(path.join(root, "src", "script.py"), "def foo(): return 42\n");
    const report = analyzeImpact(root, { base: "HEAD" });
    assert.equal(report.ok, true);
    // 2 changed files, 1 unsupported: 1.0 - (1/2)*0.5 = 0.75
    assert.equal(report.confidence, 0.75);
    assert.equal(report.verification_mode, "wider");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computeConfidence function handles various inputs according to specification", () => {
  assert.equal(
    computeConfidence({ gitOk: true, hasDiff: true, totalFiles: 1, unsupportedFiles: 0, parseErrors: 0 }),
    1.0,
  );
  assert.equal(
    computeConfidence({ gitOk: true, hasDiff: true, totalFiles: 1, unsupportedFiles: 1, parseErrors: 0 }),
    0.6,
  );
  assert.equal(
    computeConfidence({ gitOk: true, hasDiff: true, totalFiles: 2, unsupportedFiles: 1, parseErrors: 0 }),
    0.75,
  );
});
