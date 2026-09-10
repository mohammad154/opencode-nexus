import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createVerificationProvider } from "../scripts/lib/providers/verification-provider.js";
import {
  sealProviderArtifact,
  verifySealedArtifact,
  sha256Digest,
} from "../scripts/lib/artifact-seal.js";
import {
  canTransition,
  transition,
  sealImpactArtifact,
  sealVerificationReport,
} from "../scripts/lib/state-machine.js";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import {
  goodImplementerHandoff,
  sealedVerification,
  sealedImpact,
  mockTrustProviders,
} from "./helpers/gate-fixtures.js";

function passedTaskVerificationState(runId, overrides = {}) {
  return {
    ...createEmptyRunState(runId),
    state: "VERIFYING",
    review_level: "unified",
    execution_mode: "delegated",
    current_unit: "u1",
    head_commit: "base111",
    classification: { change_class: "bug-fix", review_level: "unified" },
    tdd_required: true,
    verification_status: "PASSED",
    verification: {
      ...createEmptyRunState(`${runId}-summary`).verification,
      status: "PASSED",
      phase: "TASK",
    },
    provider_verification: sealedVerification(),
    post_impact: sealedImpact({ phase: "post" }),
    ...overrides,
  };
}

test("verifyTdd records red at base commit and green at implementation commit", () => {
  const prov = createVerificationProvider();
  const baseCommit = "abc1111";
  const implCommit = "def2222";

  const tddReport = prov.verifyTdd({
    base_commit: baseCommit,
    implementer_commit: implCommit,
    command: ["npm", "test"],
    runner(step, worktree, commit, phase) {
      if (phase === "red" || commit === baseCommit) {
        return { status: 1, stdout: "FAIL test/a.test.js\nAssertionError", stderr: "" };
      }
      return { status: 0, stdout: "PASS test/a.test.js", stderr: "" };
    },
  });

  assert.ok(tddReport, "should produce a tdd report");
  assert.strictEqual(tddReport.schema_version, "1.0");
  assert.deepStrictEqual(tddReport.command, ["npm", "test"]);
  assert.strictEqual(tddReport.red.commit, baseCommit);
  assert.strictEqual(tddReport.red.exit_code, 1);
  assert.ok(tddReport.red.output_digest.startsWith("sha256:"));
  assert.strictEqual(tddReport.green.commit, implCommit);
  assert.strictEqual(tddReport.green.exit_code, 0);
  assert.ok(tddReport.green.output_digest.startsWith("sha256:"));
  assert.strictEqual(tddReport.ok, true);
  assert.strictEqual(tddReport.provider_validated, true);
  assert.strictEqual(verifySealedArtifact(tddReport), true);
});

test("verifyTdd records failure (ok === false) when base commit test passes (not red)", () => {
  const prov = createVerificationProvider();
  const tddReport = prov.verifyTdd({
    base_commit: "base",
    implementer_commit: "impl",
    command: ["npm", "test"],
    runner(step, worktree, commit, phase) {
      // Base passes when it should have failed (not a valid red state)
      return { status: 0, stdout: "PASS", stderr: "" };
    },
  });

  assert.strictEqual(tddReport.ok, false);
  assert.strictEqual(tddReport.red.exit_code, 0);
  assert.strictEqual(tddReport.green.exit_code, 0);
  assert.strictEqual(verifySealedArtifact(tddReport), true);
});

test("verifyTdd fails closed when the green run is signal-killed", () => {
  const prov = createVerificationProvider();
  const tddReport = prov.verifyTdd({
    base_commit: "base",
    implementer_commit: "impl",
    command: ["npm", "test"],
    runner(_step, _worktree, _commit, phase) {
      if (phase === "red") return { status: 1, stdout: "FAIL", stderr: "" };
      return { status: null, signal: "SIGKILL", stdout: "", stderr: "" };
    },
  });
  assert.equal(tddReport.ok, false);
  assert.equal(tddReport.red.exit_code, 1);
  assert.equal(tddReport.green.exit_code, 1);
});

test("verifyTdd records failure (ok === false) when implementer commit test fails (not green)", () => {
  const prov = createVerificationProvider();
  const tddReport = prov.verifyTdd({
    base_commit: "base",
    implementer_commit: "impl",
    command: ["npm", "test"],
    runner(step, worktree, commit, phase) {
      if (phase === "red") return { status: 1, stdout: "FAIL", stderr: "" };
      // Implementation also fails
      return { status: 2, stdout: "FAIL STILL", stderr: "" };
    },
  });

  assert.strictEqual(tddReport.ok, false);
  assert.strictEqual(tddReport.red.exit_code, 1);
  assert.strictEqual(tddReport.green.exit_code, 2);
  assert.strictEqual(verifySealedArtifact(tddReport), true);
});

test("verifyTdd computes distinct sha256 output digests for outputs", () => {
  const prov = createVerificationProvider();
  const out1 = "output 1";
  const out2 = "output 2";

  const tddReport = prov.verifyTdd({
    base_commit: "b",
    implementer_commit: "i",
    command: ["npm", "test"],
    runner(step, worktree, commit, phase) {
      if (phase === "red") return { status: 1, stdout: out1, stderr: "" };
      return { status: 0, stdout: out2, stderr: "" };
    },
  });

  assert.strictEqual(tddReport.red.output_digest, sha256Digest(out1));
  assert.strictEqual(tddReport.green.output_digest, sha256Digest(out2));
  assert.notStrictEqual(tddReport.red.output_digest, tddReport.green.output_digest);
});

test("verifyTdd discovers test command from project when no explicit command is provided", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tdd-disc-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        name: "tdd-test-pkg",
        scripts: { test: "node --test" },
      }),
    );

    const prov = createVerificationProvider();
    let executedStep = null;
    const tddReport = prov.verifyTdd({
      worktree: tmp,
      base_commit: "base",
      implementer_commit: "impl",
      runner(step) {
        executedStep = step;
        return { status: step.id === "test" ? 0 : 1, stdout: "", stderr: "" };
      },
    });

    assert.ok(executedStep);
    assert.strictEqual(executedStep.command, "npm");
    assert.deepStrictEqual(executedStep.args, ["test"]);
    assert.deepStrictEqual(tddReport.command, ["npm", "test"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("state machine enters VERIFYING for bug-fix before TDD measurement", () => {
  const state = {
    ...createEmptyRunState("tdd-run-1"),
    state: "IMPLEMENTING",
    review_level: "unified",
    execution_mode: "delegated",
    current_unit: "u1",
    head_commit: "base111",
    classification: { change_class: "bug-fix", review_level: "unified" },
    tdd_required: true,
  };

  const r = canTransition(state, "VERIFYING", {
    implementer_handoff: goodImplementerHandoff({
      run_id: "tdd-run-1",
      unit_or_task: "u1",
      base_commit: "base111",
      commit: "c1",
    }),
  });

  assert.strictEqual(r.ok, true, `Expected fast handoff gate, got: ${r.errors.join("; ")}`);
});

test("state machine rejects caller-supplied TDD evidence at REVIEWING", () => {
  const state = passedTaskVerificationState("tdd-run-2");
  const r = canTransition(state, "REVIEWING", {
    tdd_evidence: {
      red: { exit_code: 1 },
      green: { exit_code: 0 },
      ok: true,
    },
  });

  assert.strictEqual(r.ok, false);
  assert.ok(
    r.errors.some((e) => /caller-supplied tdd_evidence/i.test(e)),
    `Expected caller TDD rejection, got: ${r.errors.join("; ")}`,
  );
});

test("state machine rejects unsealed or tampered caller-supplied tdd_evidence", () => {
  const state = passedTaskVerificationState("tdd-run-3");

  // Tampered artifact with invalid digest
  const tamperedTdd = {
    schema_version: "1.0",
    test_id: "test",
    command: ["npm", "test"],
    red: { commit: "base111", exit_code: 1, output_digest: "sha256:1" },
    green: { commit: "c1", exit_code: 0, output_digest: "sha256:2" },
    ok: true,
    provider_validated: true,
    artifact_digest: "sha256:invalid_digest_tampered",
  };

  const r = canTransition(state, "REVIEWING", { tdd_evidence: tamperedTdd });

  assert.strictEqual(r.ok, false);
  assert.ok(
    r.errors.some((e) => /caller-supplied tdd_evidence/i.test(e)),
    `Expected unsealed tdd_evidence error, got: ${r.errors.join("; ")}`,
  );
});

test("state machine rejects provider-sealed TDD evidence when red exit_code is 0", () => {
  const badRedTdd = sealProviderArtifact({
    schema_version: "1.0",
    test_id: "test",
    command: ["npm", "test"],
    red: { commit: "base111", exit_code: 0, output_digest: "sha256:1" }, // NOT RED!
    green: { commit: "c1", exit_code: 0, output_digest: "sha256:2" },
    ok: false,
  });
  const state = passedTaskVerificationState("tdd-run-4", { tdd_evidence: badRedTdd });
  const r = canTransition(state, "REVIEWING", {});

  assert.strictEqual(r.ok, false);
  assert.ok(
    r.errors.some((e) => /red evidence with non-zero exit_code/i.test(e)),
    `Expected non-zero red error, got: ${r.errors.join("; ")}`,
  );
});

test("state machine rejects provider-sealed TDD evidence when green exit_code is non-zero", () => {
  const badGreenTdd = sealProviderArtifact({
    schema_version: "1.0",
    test_id: "test",
    command: ["npm", "test"],
    red: { commit: "base111", exit_code: 1, output_digest: "sha256:1" },
    green: { commit: "c1", exit_code: 1, output_digest: "sha256:2" }, // NOT GREEN!
    ok: false,
  });
  const state = passedTaskVerificationState("tdd-run-5", { tdd_evidence: badGreenTdd });
  const r = canTransition(state, "REVIEWING", {});

  assert.strictEqual(r.ok, false);
  assert.ok(
    r.errors.some((e) => /green evidence with exit_code 0/i.test(e)),
    `Expected exit_code 0 green error, got: ${r.errors.join("; ")}`,
  );
});

test("state machine admits REVIEWING when persisted provider-sealed TDD evidence is valid", () => {
  const validTdd = sealProviderArtifact({
    schema_version: "1.0",
    test_id: "test",
    command: ["npm", "test"],
    red: { commit: "base111", exit_code: 1, output_digest: "sha256:1" },
    green: { commit: "c1", exit_code: 0, output_digest: "sha256:2" },
    ok: true,
  });

  const state = passedTaskVerificationState("tdd-run-6", { tdd_evidence: validTdd });
  const r = canTransition(state, "REVIEWING", {});

  assert.strictEqual(r.ok, true, `Expected ok: true, got errors: ${r.errors.join("; ")}`);
});

test("state machine transition defers TDD provider execution to nexus verify", () => {
  const state = {
    ...createEmptyRunState("tdd-run-7"),
    state: "IMPLEMENTING",
    review_level: "unified",
    execution_mode: "delegated",
    current_unit: "u1",
    head_commit: "base111",
    classification: { change_class: "bug-fix", review_level: "unified" },
    tdd_required: true,
  };

  let verifyTddCalled = false;
  const providers = {
    ...mockTrustProviders(),
    verificationProvider: {
      discover() {
        return { steps: [{ id: "test", command: "npm", args: ["test"], kind: "test" }] };
      },
      run() {
        return { ok: true, results: [{ id: "test", command: "npm test", exit_code: 0, pass: true }] };
      },
      verifyTdd(ctx = {}) {
        verifyTddCalled = true;
        return sealProviderArtifact({
          schema_version: "1.0",
          test_id: "test",
          command: ["npm", "test"],
          red: { commit: ctx.base_commit || "base111", exit_code: 1, output_digest: "sha256:red" },
          green: { commit: ctx.implementer_commit || "c1", exit_code: 0, output_digest: "sha256:green" },
          ok: true,
        });
      },
    },
  };

  const res = transition(
    state,
    "VERIFYING",
    {
      implementer_handoff: goodImplementerHandoff({
        run_id: "tdd-run-7",
        unit_or_task: "u1",
        base_commit: "base111",
        commit: "c1",
      }),
    },
    providers,
  );

  assert.strictEqual(res.ok, true, `Transition should succeed: ${res.errors.join("; ")}`);
  assert.strictEqual(verifyTddCalled, false, "fast transition must not call verifyTdd");
  assert.equal(res.state.verification_status, "PENDING");
  assert.equal(res.state.tdd_evidence, undefined);
});

test("verifyTdd runs in a real git repository with detached base worktree", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tdd-git-"));
  try {
    const git = (...args) => spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
    git("init");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");

    // Commit 1: base with failing test (process.exit(1))
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "pkg", scripts: { test: "node test.js" } }),
    );
    fs.writeFileSync(path.join(tmp, "test.js"), "process.exit(1);\n");
    git("add", ".");
    git("commit", "-m", "base commit with failing test");
    const baseCommit = git("rev-parse", "HEAD").stdout.trim();

    // Commit 2: implementer commit with passing test (process.exit(0))
    fs.writeFileSync(path.join(tmp, "test.js"), "process.exit(0);\n");
    git("add", ".");
    git("commit", "-m", "implementer commit with passing test");
    const implCommit = git("rev-parse", "HEAD").stdout.trim();

    const prov = createVerificationProvider();
    const tddReport = prov.verifyTdd({
      worktree: tmp,
      base_commit: baseCommit,
      implementer_commit: implCommit,
    });

    assert.ok(tddReport);
    assert.strictEqual(tddReport.schema_version, "1.0");
    assert.strictEqual(tddReport.red.commit, baseCommit);
    assert.strictEqual(tddReport.red.exit_code, 1);
    assert.strictEqual(tddReport.green.commit, implCommit);
    assert.strictEqual(tddReport.green.exit_code, 0);
    assert.strictEqual(tddReport.ok, true);
    assert.strictEqual(verifySealedArtifact(tddReport), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
