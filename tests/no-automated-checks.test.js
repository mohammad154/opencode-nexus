import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { noAutomatedCheckEvidence } from "../scripts/lib/no-automated-checks.js";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-no-checks-unit-"));
}

const DIRECT = {
  state: "VERIFYING",
  fast_path: { mode: "direct", enabled: true, test_suite: false },
  allowed_files: ["src/app.js"],
  implementer_commit: "b".repeat(40),
};

test("a standard run never verifies without an executable check", () => {
  const root = workspace();
  try {
    const evidence = noAutomatedCheckEvidence(root, { state: "VERIFYING", allowed_files: ["src/app.js"] }, {
      head: "b".repeat(40),
    });
    assert.equal(evidence.ok, false);
    assert.equal(evidence.eligible, false);
    assert.equal(evidence.code, "VERIFICATION_UNAVAILABLE");
    assert.match(evidence.message, /standard run needs a runnable project check/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a direct run whose workspace recorded a test suite must run that suite", () => {
  const root = workspace();
  try {
    const evidence = noAutomatedCheckEvidence(
      root,
      { ...DIRECT, fast_path: { ...DIRECT.fast_path, test_suite: true } },
      { head: "b".repeat(40) },
    );
    assert.equal(evidence.eligible, false);
    assert.equal(evidence.code, "VERIFICATION_UNAVAILABLE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a direct run with no recorded probe is not treated as test-less", () => {
  const root = workspace();
  try {
    const evidence = noAutomatedCheckEvidence(
      root,
      { ...DIRECT, fast_path: { mode: "direct", enabled: true } },
      { head: "b".repeat(40) },
    );
    assert.equal(evidence.eligible, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a test directory that appears later makes the workspace ineligible", () => {
  const root = workspace();
  try {
    fs.mkdirSync(path.join(root, "tests"));
    const evidence = noAutomatedCheckEvidence(root, DIRECT, { head: "b".repeat(40) });
    assert.equal(evidence.eligible, false);
    assert.match(evidence.message, /now has a test suite/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HEAD that is not the sealed direct edit is refused, not verified", () => {
  const root = workspace();
  try {
    const evidence = noAutomatedCheckEvidence(root, DIRECT, { head: "c".repeat(40) });
    assert.equal(evidence.ok, false);
    assert.equal(evidence.eligible, true);
    assert.equal(evidence.code, "NO_SEALED_DIRECT_EDIT");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});