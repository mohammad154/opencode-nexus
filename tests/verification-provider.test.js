import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  createVerificationProvider,
  resolveVerificationTimeouts,
  resolveExecutable,
  runStep,
} from "../scripts/lib/providers/verification-provider.js";
import { verifySealedArtifact } from "../scripts/lib/artifact-seal.js";
import { discoverVerification } from "../scripts/lib/verification/discover.js";

function writeFixtureFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "fixture");
}

function windowsFixtureOptions(root, binPath) {
  return {
    platform: "win32",
    cwd: root,
    env: {
      // Windows environment names are case-insensitive.
      Path: `${binPath};${path.join(root, "secondary-bin")}`,
      pathext: ".cmd;.exe;.bat",
    },
    // Use the host path implementation so this fixture runs on POSIX too.
    pathModule: path,
  };
}

test("resolveExecutable resolves Windows PATH/PATHEXT commands portably", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-executable-"));
  const bin = path.join(tmp, "bin");
  const secondaryBin = path.join(tmp, "secondary-bin");
  try {
    writeFixtureFile(path.join(bin, "npm.cmd"));
    writeFixtureFile(path.join(bin, "npm.exe"));
    writeFixtureFile(path.join(bin, "npm.bat"));
    writeFixtureFile(path.join(secondaryBin, "pnpm.bat"));
    const options = windowsFixtureOptions(tmp, bin);

    assert.equal(resolveExecutable("npm", options), path.join(bin, "npm.cmd"));
    assert.equal(resolveExecutable("pnpm", options), path.join(secondaryBin, "pnpm.bat"));
    assert.equal(resolveExecutable("npm.exe", options), path.join(bin, "npm.exe"));
    assert.equal(
      resolveExecutable(path.join(bin, "npm"), options),
      path.join(bin, "npm.cmd"),
    );
    assert.equal(
      resolveExecutable(path.join(bin, "npm.cmd"), options),
      path.join(bin, "npm.cmd"),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveExecutable leaves POSIX commands unchanged", () => {
  assert.equal(
    resolveExecutable("npm", {
      platform: "linux",
      env: { PATH: "/fixture/bin" },
    }),
    "npm",
  );
});

test("resolveExecutable handles Windows-qualified paths through an injected file probe", () => {
  const existing = new Set(["C:\\tools\\npm.cmd"]);
  const options = {
    platform: "win32",
    cwd: "C:\\worktree",
    env: { PATH: "C:\\other", PATHEXT: ".cmd;.exe;.bat" },
    pathModule: path.win32,
    isFile: (candidate) => existing.has(candidate),
  };

  assert.equal(
    resolveExecutable("C:\\tools\\npm", options),
    "C:\\tools\\npm.cmd",
  );
  assert.equal(
    resolveExecutable("C:\\tools\\npm.cmd", options),
    "C:\\tools\\npm.cmd",
  );
});

test("runStep uses the resolved Windows executable with shell:false", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-run-step-"));
  const bin = path.join(tmp, "bin");
  const commandPath = path.join(bin, "npm.cmd");
  try {
    writeFixtureFile(commandPath);
    const options = windowsFixtureOptions(tmp, bin);
    let invocation;
    const result = runStep(
      { command: "npm", args: ["test"] },
      tmp,
      1000,
      {
        ...options,
        spawnSync(command, args, spawnOptions) {
          invocation = { command, args, spawnOptions };
          return { status: 0, stdout: "ok", stderr: "" };
        },
      },
    );

    assert.equal(result.status, 0);
    assert.equal(invocation.command, commandPath);
    assert.deepEqual(invocation.args, ["test"]);
    assert.equal(invocation.spawnOptions.shell, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

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

test("verifyTdd fails closed when a runner reports status 0 with a spawn error", () => {
  const prov = createVerificationProvider();
  const tddReport = prov.verifyTdd({
    base_commit: "base",
    implementer_commit: "impl",
    command: ["npm", "test"],
    runner(_step, _worktree, _commit, phase) {
      if (phase === "red") return { status: 1, stdout: "FAIL", stderr: "" };
      return {
        status: 0,
        error: Object.assign(new Error("runner could not start process"), { code: "EIO" }),
        stdout: "",
        stderr: "",
      };
    },
  });

  assert.equal(tddReport.ok, false);
  assert.equal(tddReport.green.exit_code, 1);
  assert.equal(tddReport.green.error_code, "EIO");
  assert.match(tddReport.green.error_message, /could not start process/i);
  assert.match(tddReport.green.stderr_tail, /could not start process/i);
  assert.match(tddReport.artifact_digest, /^sha256:/);
  assert.equal(verifySealedArtifact(tddReport), true);
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
