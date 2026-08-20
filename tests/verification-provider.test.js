import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createVerificationProvider } from "../scripts/lib/providers/verification-provider.js";
import { discoverVerification } from "../scripts/lib/verification/discover.js";

test("verification fails closed when zero executable checks exist", () => {
  const prov = createVerificationProvider();
  const res = prov.run({ plan: { steps: [] } });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, "VERIFICATION_UNAVAILABLE");
});

test("verification fails closed when all steps are UNAVAILABLE", () => {
  const prov = createVerificationProvider();
  const res = prov.run({
    plan: {
      steps: [
        { id: "s1", status: "UNAVAILABLE", command: "foo", args: [] },
      ],
    },
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, "VERIFICATION_UNAVAILABLE");
});

test("verification succeeds when at least one check passes and others are UNAVAILABLE", () => {
  const prov = createVerificationProvider();
  const res = prov.run({
    plan: {
      steps: [
        { id: "s1", status: "UNAVAILABLE", command: "foo", args: [] },
        { id: "s2", command: process.execPath, args: ["-e", "process.exit(0)"] },
      ],
    },
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.code, undefined);
  assert.strictEqual(res.results.length, 2);
});

test("verification fails when an executed check fails", () => {
  const prov = createVerificationProvider();
  const res = prov.run({
    plan: {
      steps: [
        { id: "s1", command: process.execPath, args: ["-e", "process.exit(1)"] },
      ],
    },
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, undefined);
});

test("discoverVerification filters steps based on risk ladder", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verif-discover-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        name: "test-pkg",
        scripts: {
          test: "node --test",
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          build: "tsc",
        },
      }),
    );
    fs.writeFileSync(path.join(tmp, "test.js"), "// test");

    // LOW risk: related_tests, lint (no test, no typecheck, no build)
    const lowPlan = discoverVerification(tmp, {
      risk: "LOW",
      related_tests: ["test.js"],
    });
    const lowIds = lowPlan.steps.map((s) => s.id);
    assert.ok(lowIds.includes("lint"));
    assert.ok(lowIds.includes("related:test.js"));
    assert.ok(!lowIds.includes("test"));
    assert.ok(!lowIds.includes("typecheck"));
    assert.ok(!lowIds.includes("build"));

    // MEDIUM risk: related_tests, lint, typecheck (no full test, no build)
    const medPlan = discoverVerification(tmp, {
      risk: "MEDIUM",
      related_tests: ["test.js"],
    });
    const medIds = medPlan.steps.map((s) => s.id);
    assert.ok(medIds.includes("lint"));
    assert.ok(medIds.includes("typecheck"));
    assert.ok(medIds.includes("related:test.js"));
    assert.ok(!medIds.includes("test"));
    assert.ok(!medIds.includes("build"));

    // HIGH risk: full_tests, related_tests, lint, typecheck, build
    const highPlan = discoverVerification(tmp, {
      risk: "HIGH",
      related_tests: ["test.js"],
    });
    const highIds = highPlan.steps.map((s) => s.id);
    assert.ok(highIds.includes("test"));
    assert.ok(highIds.includes("lint"));
    assert.ok(highIds.includes("typecheck"));
    assert.ok(highIds.includes("build"));
    assert.ok(highIds.includes("related:test.js"));

    // CRITICAL risk: full_tests, related_tests, lint, typecheck, build
    const critPlan = discoverVerification(tmp, {
      risk: "CRITICAL",
      related_tests: ["test.js"],
    });
    const critIds = critPlan.steps.map((s) => s.id);
    assert.ok(critIds.includes("test"));
    assert.ok(critIds.includes("lint"));
    assert.ok(critIds.includes("typecheck"));
    assert.ok(critIds.includes("build"));
    assert.ok(critIds.includes("related:test.js"));

    // Default without risk: all discovered package.json steps present
    const defaultPlan = discoverVerification(tmp, {
      related_tests: ["test.js"],
    });
    const defIds = defaultPlan.steps.map((s) => s.id);
    assert.ok(defIds.includes("test"));
    assert.ok(defIds.includes("lint"));
    assert.ok(defIds.includes("typecheck"));
    assert.ok(defIds.includes("build"));
    assert.ok(defIds.includes("related:test.js"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
