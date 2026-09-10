import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  createVerificationProvider,
  resolveVerificationTimeouts,
} from "../scripts/lib/providers/verification-provider.js";
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

test("verification fails when a spawn-missing check is mixed with a passing check", () => {
  const prov = createVerificationProvider();
  const res = prov.run({
    plan: {
      steps: [
        { id: "lint", command: "definitely-not-a-nexus-binary", args: ["."], kind: "lint" },
        { id: "test", command: process.execPath, args: ["-e", "process.exit(0)"], kind: "test" },
      ],
    },
  });
  assert.equal(res.ok, false);
  const lint = res.results.find((r) => r.id === "lint");
  assert.equal(lint.status, "FAILED");
  assert.equal(lint.pass, false);
  assert.equal(lint.exit_code, null);
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

test("verification timeouts are configurable and a timed-out step fails closed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verif-timeout-"));
  const oldTimeout = process.env.NEXUS_VERIFY_TIMEOUT_TEST;
  try {
    fs.mkdirSync(path.join(tmp, ".opencode", "config"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".opencode", "config", "workflow.json"),
      JSON.stringify({ verificationTimeouts: { fullTest: 0.08, build: 12 } }),
    );
    process.env.NEXUS_VERIFY_TIMEOUT_TEST = "0.05";
    const resolved = resolveVerificationTimeouts(tmp);
    assert.equal(resolved.fullTest, 50, "environment override wins over project config");
    assert.equal(resolved.build, 12000, "project config overrides package default");

    const provider = createVerificationProvider({ timeouts: { fullTest: 0.05 } });
    const result = provider.run({
      worktree: tmp,
      plan: {
        steps: [
          {
            id: "test",
            command: process.execPath,
            args: ["-e", "setTimeout(() => {}, 1000)"],
            kind: "test",
          },
        ],
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.timed_out, true);
    assert.equal(result.results[0].status, "TIMED_OUT");
    assert.equal(result.results[0].timed_out, true);
  } finally {
    if (oldTimeout == null) delete process.env.NEXUS_VERIFY_TIMEOUT_TEST;
    else process.env.NEXUS_VERIFY_TIMEOUT_TEST = oldTimeout;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

    // LOW risk: related_tests, lint, full_tests safety net (no typecheck/build)
    const lowPlan = discoverVerification(tmp, {
      risk: "LOW",
      related_tests: ["test.js"],
    });
    const lowIds = lowPlan.steps.map((s) => s.id);
    assert.ok(lowIds.includes("lint"));
    assert.ok(lowIds.includes("related:test.js"));
    assert.ok(lowIds.includes("test"), "LOW keeps full_tests as safety net");
    assert.ok(!lowIds.includes("typecheck"));
    assert.ok(!lowIds.includes("build"));

    // MEDIUM risk: related_tests, lint, typecheck, full_tests (no build)
    const medPlan = discoverVerification(tmp, {
      risk: "MEDIUM",
      related_tests: ["test.js"],
    });
    const medIds = medPlan.steps.map((s) => s.id);
    assert.ok(medIds.includes("lint"));
    assert.ok(medIds.includes("typecheck"));
    assert.ok(medIds.includes("related:test.js"));
    assert.ok(medIds.includes("test"), "MEDIUM keeps full_tests as safety net");
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
