/**
 * V4.5 runtime invariants (plan §28) and the lean-assurance behavior changes.
 *
 * These assert *work counts*, not milliseconds: an expensive command must not
 * run twice for one evidence identity, and every identity change must force a
 * rerun. Reuse may reduce computation; it may never reduce required evidence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createEmptyRunState,
  normalizeAndValidateHandoff,
} from "../scripts/lib/migrate-artifacts.js";
import { canTransition, sealImpactArtifact } from "../scripts/lib/state-machine.js";
import { revalidateTransitionEvidence } from "../scripts/lib/state-machine.js";
import { runVerificationLifecycle } from "../scripts/lib/verification-lifecycle.js";
import { createVerificationProvider } from "../scripts/lib/providers/verification-provider.js";
import {
  computeImpactIdentity,
  createNexusImpactProvider,
} from "../scripts/lib/providers/impact-provider.js";
import { verificationLadder } from "../scripts/lib/verification/compare.js";
import { resolveLadderLevels } from "../scripts/lib/verification/discover.js";
import { goodImplementerHandoff } from "./helpers/gate-fixtures.js";

const REAL_TIMEOUTS = Object.freeze({
  targetedTest: 30000,
  fullTest: 30000,
  lint: 30000,
  typecheck: 30000,
  build: 30000,
});

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr || result.stdout}`);
  return String(result.stdout || "").trim();
}

function makeRepository(prefix = "nexus-runtime-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Nexus Test"]);
  git(root, ["config", "user.email", "nexus@example.test"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 2;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "implementation"]);
  return { root, base, head: git(root, ["rev-parse", "HEAD"]) };
}

/**
 * A counter lives outside the repository on purpose: writing inside it would
 * dirty the workspace and change the very identity under test.
 */
function makeCountingCommand(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nexus-count-${label}-`));
  const counter = path.join(dir, "count.log");
  const script = path.join(dir, "run.cjs");
  fs.writeFileSync(
    script,
    `require("fs").appendFileSync(${JSON.stringify(counter)}, "x\\n");\n`,
  );
  return {
    dir,
    step(id = "test", kind = "test") {
      return { id, command: process.execPath, args: [script], kind };
    },
    executions() {
      if (!fs.existsSync(counter)) return 0;
      return fs
        .readFileSync(counter, "utf8")
        .split("\n")
        .filter(Boolean).length;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function taskState(runId, repository, overrides = {}) {
  return {
    ...createEmptyRunState(runId),
    state: "VERIFYING",
    worktree: repository.root,
    current_unit: "unit-1",
    allowed_files: ["src/app.js"],
    head_commit: repository.base,
    implementer_commit: repository.head,
    last_implementer_handoff: goodImplementerHandoff({
      run_id: runId,
      unit_or_task: "unit-1",
      base_commit: repository.base,
      commit: repository.head,
      files_changed: ["src/app.js"],
    }),
    verification_policy: { exempt: false, reason: null },
    ...overrides,
  };
}

function finalState(runId, repository, overrides = {}) {
  return {
    ...createEmptyRunState(runId),
    state: "FINAL_VERIFYING",
    worktree: repository.root,
    head_commit: repository.base,
    implementer_commit: repository.head,
    last_final_review_handoff: { reviewed_commit: repository.head },
    last_review_handoff: { reviewed_commit: repository.head },
    verification_policy: { exempt: false, reason: null },
    ...overrides,
  };
}

/**
 * Real verification provider (so identities are computed and honored) with a
 * fixed plan and mocked impact/timeouts.
 */
function providers({
  steps,
  impactReport = { ok: true, risk: "LOW", related_tests: [] },
  verifyTdd = null,
  timeouts = REAL_TIMEOUTS,
} = {}) {
  const real = createVerificationProvider();
  const verificationPlan = { steps };
  return {
    impactProvider: {
      analyze() {
        return { ok: impactReport.ok !== false, report: impactReport };
      },
    },
    verificationProvider: {
      resolveTimeouts() {
        return { ...timeouts };
      },
      discover() {
        return { steps: verificationPlan.steps.map((step) => ({ ...step })) };
      },
      run(ctx) {
        return real.run({ ...ctx, timeouts });
      },
      compare() {
        return { ok: true, new_regressions: [] };
      },
      ...(verifyTdd ? { verifyTdd } : {}),
    },
  };
}

function resultFor(artifact, id) {
  return (artifact?.results || []).find((result) => result.id === id);
}

// ---------------------------------------------------------------------------
// R1 / Phase 4: one identity, one execution
// ---------------------------------------------------------------------------

test("R1: final verification reuses a task result with an unchanged identity", () => {
  const repository = makeRepository("nexus-r1-");
  const counter = makeCountingCommand("r1");
  try {
    const taskRun = runVerificationLifecycle({
      worktree: repository.root,
      state: taskState("r1", repository),
      providers: providers({ steps: [counter.step()] }),
    });
    assert.equal(taskRun.ok, true, taskRun.error);
    assert.equal(counter.executions(), 1);
    const taskResult = resultFor(taskRun.verification, "test");
    assert.equal(taskResult.status, "PASSED");
    assert.match(taskResult.identity, /^sha256:/);

    const finalRun = runVerificationLifecycle({
      worktree: repository.root,
      state: finalState("r1", repository, {
        provider_verification: taskRun.verification,
      }),
      providers: providers({ steps: [counter.step()] }),
    });
    assert.equal(finalRun.ok, true, finalRun.error);
    assert.equal(
      counter.executions(),
      1,
      "an identical identity must not execute the command a second time",
    );
    const finalResult = resultFor(finalRun.verification, "test");
    assert.equal(finalResult.status, "REUSED");
    assert.equal(finalResult.reuse_source, "task_verification");
    assert.equal(finalRun.verification.reused_steps, 1);
    assert.equal(finalRun.verification.ran_steps, 0);
    assert.equal(finalRun.verification.ok, true);
  } finally {
    counter.cleanup();
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("R2: a changed HEAD invalidates reusable code-dependent evidence", () => {
  const repository = makeRepository("nexus-r2-");
  const counter = makeCountingCommand("r2");
  try {
    const taskRun = runVerificationLifecycle({
      worktree: repository.root,
      state: taskState("r2", repository),
      providers: providers({ steps: [counter.step()] }),
    });
    assert.equal(taskRun.ok, true, taskRun.error);
    assert.equal(counter.executions(), 1);

    fs.writeFileSync(path.join(repository.root, "src", "app.js"), "export const value = 3;\n");
    git(repository.root, ["add", "."]);
    git(repository.root, ["commit", "-m", "later change"]);
    const movedHead = git(repository.root, ["rev-parse", "HEAD"]);

    const finalRun = runVerificationLifecycle({
      worktree: repository.root,
      state: finalState("r2", { ...repository, head: movedHead }, {
        provider_verification: taskRun.verification,
      }),
      providers: providers({ steps: [counter.step()] }),
    });
    assert.equal(finalRun.ok, true, finalRun.error);
    assert.equal(counter.executions(), 2, "a new HEAD must be measured again");
    assert.equal(resultFor(finalRun.verification, "test").status, "PASSED");
  } finally {
    counter.cleanup();
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("R3: a changed workspace digest invalidates verification reuse", () => {
  const repository = makeRepository("nexus-r3-");
  const counter = makeCountingCommand("r3");
  try {
    const taskRun = runVerificationLifecycle({
      worktree: repository.root,
      state: taskState("r3", repository),
      providers: providers({ steps: [counter.step()] }),
    });
    assert.equal(taskRun.ok, true, taskRun.error);

    // Uncommitted content change: HEAD is identical, source state is not.
    fs.writeFileSync(path.join(repository.root, "src", "app.js"), "export const value = 99;\n");

    const finalRun = runVerificationLifecycle({
      worktree: repository.root,
      state: finalState("r3", repository, {
        provider_verification: taskRun.verification,
      }),
      providers: providers({ steps: [counter.step()] }),
    });
    assert.equal(
      counter.executions(),
      2,
      "an unchanged HEAD with changed content must still be re-measured",
    );
    assert.equal(resultFor(finalRun.verification, "test").status, "PASSED");
    assert.equal(finalRun.verification.reused_steps, 0);
    // The dirty source state is still recorded, so the completion gate can
    // reject it: reuse was refused *and* the evidence stays honest.
    assert.equal(finalRun.verification.workspace_clean, false);
    assert.ok(finalRun.verification.dirty_paths.includes("src/app.js"));
  } finally {
    counter.cleanup();
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("R4: changed verification configuration invalidates reuse", () => {
  const repository = makeRepository("nexus-r4-");
  const counter = makeCountingCommand("r4");
  try {
    const taskRun = runVerificationLifecycle({
      worktree: repository.root,
      state: taskState("r4", repository),
      providers: providers({ steps: [counter.step()] }),
    });
    assert.equal(taskRun.ok, true, taskRun.error);
    assert.equal(counter.executions(), 1);

    const finalRun = runVerificationLifecycle({
      worktree: repository.root,
      state: finalState("r4", repository, {
        provider_verification: taskRun.verification,
      }),
      providers: providers({
        steps: [counter.step()],
        timeouts: { ...REAL_TIMEOUTS, fullTest: 29000 },
      }),
    });
    assert.equal(finalRun.ok, true, finalRun.error);
    assert.equal(
      counter.executions(),
      2,
      "a different timeout configuration is a different identity",
    );
  } finally {
    counter.cleanup();
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("R10: reuse never removes a required check from the final plan", () => {
  const repository = makeRepository("nexus-r10-");
  const reused = makeCountingCommand("r10a");
  const added = makeCountingCommand("r10b");
  try {
    const taskRun = runVerificationLifecycle({
      worktree: repository.root,
      state: taskState("r10", repository),
      providers: providers({ steps: [reused.step("test")] }),
    });
    assert.equal(taskRun.ok, true, taskRun.error);

    // Final verification requires one more check than the task phase did.
    const finalRun = runVerificationLifecycle({
      worktree: repository.root,
      state: finalState("r10", repository, {
        provider_verification: taskRun.verification,
      }),
      providers: providers({
        steps: [reused.step("test"), added.step("build", "build")],
      }),
    });
    assert.equal(finalRun.ok, true, finalRun.error);
    assert.equal(reused.executions(), 1, "the matched check is reused");
    assert.equal(added.executions(), 1, "the missing check still executes");
    assert.equal(resultFor(finalRun.verification, "test").status, "REUSED");
    assert.equal(resultFor(finalRun.verification, "build").status, "PASSED");
    assert.equal(finalRun.verification.results.length, 2);
  } finally {
    reused.cleanup();
    added.cleanup();
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("R6/R11: a failing task result is never reused to authorize final verification", () => {
  const repository = makeRepository("nexus-fail-reuse-");
  try {
    const failingStep = {
      id: "test",
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      kind: "test",
    };
    const taskRun = runVerificationLifecycle({
      worktree: repository.root,
      state: taskState("fr", repository),
      providers: providers({ steps: [failingStep] }),
    });
    assert.equal(taskRun.ok, false);
    // A failed run seals its evidence into run state rather than returning it.
    const failedArtifact = taskRun.state.provider_verification;
    assert.equal(failedArtifact.ok, false);
    assert.equal(resultFor(failedArtifact, "test").pass, false);

    const finalRun = runVerificationLifecycle({
      worktree: repository.root,
      state: finalState("fr", repository, {
        provider_verification: failedArtifact,
      }),
      providers: providers({ steps: [failingStep] }),
    });
    assert.equal(finalRun.ok, false, "a cached failure cannot become a pass");
    const finalArtifact = finalRun.state.final_verification;
    assert.equal(finalArtifact.ok, false);
    assert.equal(resultFor(finalArtifact, "test").status, "FAILED");
    assert.equal(finalArtifact.reused_steps, 0);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("R7: a corrupt task artifact falls back to recomputation", () => {
  const repository = makeRepository("nexus-r7-");
  const counter = makeCountingCommand("r7");
  try {
    const taskRun = runVerificationLifecycle({
      worktree: repository.root,
      state: taskState("r7", repository),
      providers: providers({ steps: [counter.step()] }),
    });
    assert.equal(taskRun.ok, true, taskRun.error);

    // Tamper with the sealed artifact: its digest no longer matches.
    const tampered = { ...taskRun.verification, ok: true, results: [
      { ...resultFor(taskRun.verification, "test"), stdout_tail: "tampered" },
    ] };

    const finalRun = runVerificationLifecycle({
      worktree: repository.root,
      state: finalState("r7", repository, { provider_verification: tampered }),
      providers: providers({ steps: [counter.step()] }),
    });
    assert.equal(finalRun.ok, true, finalRun.error);
    assert.equal(counter.executions(), 2, "a broken seal must not be reused");
  } finally {
    counter.cleanup();
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 2: TDD green reuse
// ---------------------------------------------------------------------------

test("Phase 2: a passing TDD green run satisfies the identical verification step", () => {
  const repository = makeRepository("nexus-tdd-reuse-");
  const counter = makeCountingCommand("tdd");
  try {
    const step = counter.step();
    const real = createVerificationProvider();
    const tddProviders = providers({
      steps: [step],
      verifyTdd(ctx) {
        // Red at the base commit, green in the worktree — both real executions.
        return real.verifyTdd({
          ...ctx,
          step,
          base_worktree: null,
          base_commit: repository.base,
          implementer_commit: repository.head,
          runner: (candidate, worktree, _commit, phase) => {
            if (phase === "red") return { status: 1, stdout: "red", stderr: "" };
            const result = spawnSync(candidate.command, candidate.args, {
              cwd: worktree,
              encoding: "utf8",
            });
            return result;
          },
        });
      },
    });

    const run = runVerificationLifecycle({
      worktree: repository.root,
      state: taskState("tdd", repository, {
        verification_policy: { exempt: false, reason: null },
        change_class: "bug-fix",
        last_implementer_handoff: goodImplementerHandoff({
          run_id: "tdd",
          unit_or_task: "unit-1",
          base_commit: repository.base,
          commit: repository.head,
          files_changed: ["src/app.js"],
          tdd_required: true,
        }),
      }),
      providers: tddProviders,
    });

    assert.equal(run.ok, true, run.error);
    assert.ok(run.artifact.tdd_evidence, "the fixture change class must require TDD");
    assert.equal(run.artifact.tdd_evidence.ok, true);
    assert.equal(run.artifact.tdd_evidence.red.exit_code, 1);
    assert.equal(run.artifact.tdd_evidence.green.exit_code, 0);

    const result = resultFor(run.verification, "test");
    assert.equal(result.status, "REUSED", "green evidence replaces the identical step");
    assert.equal(result.reuse_source, "tdd_green");
    assert.equal(counter.executions(), 1, "green executes once, not twice");
    assert.equal(run.verification.reused_steps, 1);
    assert.equal(run.verification.ran_steps, 0);
  } finally {
    counter.cleanup();
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("Phase 2: TDD green is not reused when the workspace changed during measurement", () => {
  const repository = makeRepository("nexus-tdd-dirty-");
  const counter = makeCountingCommand("tdddirty");
  try {
    const step = counter.step();
    const real = createVerificationProvider();
    const tddProviders = providers({
      steps: [step],
      verifyTdd(ctx) {
        return real.verifyTdd({
          ...ctx,
          step,
          base_commit: repository.base,
          implementer_commit: repository.head,
          runner: (candidate, worktree, _commit, phase) => {
            if (phase === "red") return { status: 1, stdout: "red", stderr: "" };
            const result = spawnSync(candidate.command, candidate.args, {
              cwd: worktree,
              encoding: "utf8",
            });
            // The measurement mutated tracked source, so the green result no
            // longer describes the state the provider steps will see.
            fs.writeFileSync(
              path.join(repository.root, "src", "app.js"),
              "export const value = 7;\n",
            );
            return result;
          },
        });
      },
    });

    const run = runVerificationLifecycle({
      worktree: repository.root,
      state: taskState("tdddirty", repository, { change_class: "bug-fix" }),
      providers: tddProviders,
    });

    assert.equal(resultFor(run.verification, "test").status, "PASSED");
    assert.equal(
      counter.executions(),
      2,
      "an unprovable green identity must be re-measured",
    );
    assert.equal(run.verification.reused_steps, 0);
  } finally {
    counter.cleanup();
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 3: LOW ladder
// ---------------------------------------------------------------------------

test("Phase 3: LOW declares a fallback instead of always requiring the full suite", () => {
  const low = verificationLadder("LOW");
  assert.deepEqual(low.levels, ["related_tests", "lint"]);
  assert.deepEqual(low.fallback_levels, ["full_tests"]);
  assert.equal(low.require_full, false);

  for (const tier of ["MEDIUM", "HIGH", "CRITICAL"]) {
    assert.ok(
      verificationLadder(tier).levels.includes("full_tests"),
      `${tier} still requires the full suite`,
    );
    assert.deepEqual(verificationLadder(tier).fallback_levels, []);
  }
  assert.equal(verificationLadder("HIGH").require_full, true);
  assert.equal(verificationLadder("CRITICAL").dual_review, true);
});

test("Phase 3: LOW without executable targeted evidence still requires the full suite", () => {
  const withTarget = resolveLadderLevels(
    [
      { id: "test", kind: "test", command: "npm" },
      { id: "related:src/app.test.js", kind: "targeted-test", command: "npm" },
    ],
    { risk: "LOW" },
  );
  assert.equal(withTarget.targeted_evidence, true);
  assert.equal(withTarget.levels.has("full_tests"), false);

  const unavailableTarget = resolveLadderLevels(
    [
      { id: "test", kind: "test", command: "npm" },
      {
        id: "related:src/app.test.js",
        kind: "targeted-test",
        command: "pytest",
        status: "UNAVAILABLE",
      },
    ],
    { risk: "LOW" },
  );
  assert.equal(
    unavailableTarget.targeted_evidence,
    false,
    "an unavailable targeted step is not executable evidence",
  );
  assert.equal(unavailableTarget.levels.has("full_tests"), true);
  assert.deepEqual(unavailableTarget.fallback_reasons, ["no_targeted_evidence"]);
});

test("R8: LOW never converts unknown or low-confidence impact into targeted-only verification", () => {
  const steps = [
    { id: "test", kind: "test", command: "npm" },
    { id: "related:src/app.test.js", kind: "targeted-test", command: "npm" },
  ];
  const unknown = resolveLadderLevels(steps, { risk: "UNKNOWN" });
  assert.equal(unknown.levels.has("full_tests"), true);
  assert.equal(unknown.require_full, true);

  const lowConfidence = resolveLadderLevels(steps, { risk: "LOW", confidence: 0.5 });
  assert.equal(lowConfidence.levels.has("full_tests"), true);
  assert.deepEqual(lowConfidence.forcing_reasons, ["low_impact_confidence"]);

  const incomplete = resolveLadderLevels(steps, { risk: "LOW", analysis_complete: false });
  assert.equal(incomplete.levels.has("full_tests"), true);
});

// ---------------------------------------------------------------------------
// Phase 1: single-owner verification
// ---------------------------------------------------------------------------

function implementerEvidence(repository, overrides = {}) {
  const handoff = goodImplementerHandoff({
    run_id: "p1",
    unit_or_task: "unit-1",
    base_commit: repository.base,
    commit: repository.head,
    files_changed: ["src/app.js"],
    ...overrides,
  });
  if (overrides.development_checks !== undefined) {
    delete handoff.verification_gates;
    handoff.development_checks = overrides.development_checks;
  }
  return handoff;
}

function implementingState(repository) {
  return {
    ...createEmptyRunState("p1"),
    state: "IMPLEMENTING",
    worktree: repository.root,
    current_unit: "unit-1",
    allowed_files: ["src/app.js"],
    head_commit: repository.base,
    implementer_commit: repository.head,
    verification_policy: { exempt: false, reason: null },
  };
}

test("Phase 1: development_checks alone authorizes the VERIFYING transition", () => {
  const repository = makeRepository("nexus-p1-");
  try {
    const handoff = implementerEvidence(repository, {
      development_checks: [
        { id: "regression-test", cmd: "node --test tests/app.test.js", pass: true },
      ],
    });
    assert.equal(Object.hasOwn(handoff, "verification_gates"), false);

    const validation = normalizeAndValidateHandoff("implementer", handoff);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors));

    const decision = canTransition(implementingState(repository), "VERIFYING", {
      worktree: repository.root,
      implementer_handoff: handoff,
    });
    assert.equal(
      decision.errors.some((error) => /development_checks|verification_gates/.test(error)),
      false,
      `implementation checks must be accepted: ${decision.errors.join("; ")}`,
    );
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("Phase 1: reporting no implementation check at all still fails closed", () => {
  const repository = makeRepository("nexus-p1-empty-");
  try {
    const handoff = implementerEvidence(repository, { development_checks: [] });
    const decision = canTransition(implementingState(repository), "VERIFYING", {
      worktree: repository.root,
      implementer_handoff: handoff,
    });
    assert.equal(decision.ok, false);
    assert.ok(
      decision.errors.some((error) => error.includes("non-empty development_checks")),
      decision.errors.join("; "),
    );
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("Phase 1: a failing implementation check still fails closed", () => {
  const repository = makeRepository("nexus-p1-fail-");
  try {
    const handoff = implementerEvidence(repository, {
      development_checks: [{ id: "targeted", cmd: "node --test", pass: false }],
    });
    const decision = canTransition(implementingState(repository), "VERIFYING", {
      worktree: repository.root,
      implementer_handoff: handoff,
    });
    assert.equal(decision.ok, false);
    assert.ok(
      decision.errors.some((error) =>
        error.includes("all implementation checks must have pass: true"),
      ),
      decision.errors.join("; "),
    );
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("Phase 1: the legacy verification_gates field remains accepted", () => {
  const repository = makeRepository("nexus-p1-legacy-");
  try {
    const handoff = implementerEvidence(repository);
    assert.ok(Array.isArray(handoff.verification_gates));
    const validation = normalizeAndValidateHandoff("implementer", handoff);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("Phase 1: a handoff reporting neither field is rejected by the contract check", () => {
  const repository = makeRepository("nexus-p1-none-");
  try {
    const handoff = implementerEvidence(repository);
    delete handoff.verification_gates;
    const validation = normalizeAndValidateHandoff("implementer", handoff);
    assert.equal(validation.ok, false);
    assert.ok(
      validation.errors.some((error) =>
        String(error.message || error).includes("development_checks"),
      ),
      JSON.stringify(validation.errors),
    );
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 5: pre-impact reuse
// ---------------------------------------------------------------------------

function impactProviderCounting() {
  const inner = createNexusImpactProvider();
  let calls = 0;
  return {
    ...inner,
    get calls() {
      return calls;
    },
    computeIdentity(ctx) {
      return inner.computeIdentity(ctx);
    },
    analyze(ctx) {
      calls += 1;
      return inner.analyze(ctx);
    },
  };
}

test("Phase 5: an unchanged pre-impact identity is reused instead of recomputed", () => {
  const repository = makeRepository("nexus-p5-");
  try {
    const impactProvider = impactProviderCounting();
    const state = {
      ...createEmptyRunState("p5"),
      state: "PLANNED",
      worktree: repository.root,
    };
    const ctx = { worktree: repository.root, planned_targets: ["src/app.js"] };

    const first = revalidateTransitionEvidence(
      "TASK_IMPACT_READY",
      ctx,
      { impactProvider },
      state,
    );
    assert.deepEqual(first.errors, []);
    assert.equal(impactProvider.calls, 1);
    assert.equal(first.ctx.impact_reused, false);
    assert.match(first.ctx.impact.impact_identity, /^sha256:/);

    // Same HEAD, same workspace, same targets, same policy → same identity.
    const second = revalidateTransitionEvidence(
      "TASK_IMPACT_READY",
      ctx,
      { impactProvider },
      { ...state, impact: first.ctx.impact },
    );
    assert.deepEqual(second.errors, []);
    assert.equal(
      impactProvider.calls,
      1,
      "an unchanged identity must not recompute the analysis",
    );
    assert.equal(second.ctx.impact_reused, true);
    assert.equal(second.ctx.impact.artifact_digest, first.ctx.impact.artifact_digest);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("R5: a changed target scope invalidates pre-impact reuse", () => {
  const repository = makeRepository("nexus-r5-");
  try {
    fs.writeFileSync(path.join(repository.root, "src", "other.js"), "export const other = 1;\n");
    git(repository.root, ["add", "."]);
    git(repository.root, ["commit", "-m", "add other"]);

    const impactProvider = impactProviderCounting();
    const state = {
      ...createEmptyRunState("r5"),
      state: "PLANNED",
      worktree: repository.root,
    };
    const first = revalidateTransitionEvidence(
      "TASK_IMPACT_READY",
      { worktree: repository.root, planned_targets: ["src/app.js"] },
      { impactProvider },
      state,
    );
    assert.equal(impactProvider.calls, 1);

    const widened = revalidateTransitionEvidence(
      "TASK_IMPACT_READY",
      { worktree: repository.root, planned_targets: ["src/app.js", "src/other.js"] },
      { impactProvider },
      { ...state, impact: first.ctx.impact },
    );
    assert.equal(impactProvider.calls, 2, "a different target set must recompute");
    assert.equal(widened.ctx.impact_reused, false);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("R2 (impact): a changed HEAD invalidates pre-impact reuse", () => {
  const repository = makeRepository("nexus-p5-head-");
  try {
    const impactProvider = impactProviderCounting();
    const state = {
      ...createEmptyRunState("p5h"),
      state: "PLANNED",
      worktree: repository.root,
    };
    const ctx = { worktree: repository.root, planned_targets: ["src/app.js"] };
    const first = revalidateTransitionEvidence(
      "TASK_IMPACT_READY",
      ctx,
      { impactProvider },
      state,
    );
    assert.equal(impactProvider.calls, 1);

    fs.writeFileSync(path.join(repository.root, "src", "app.js"), "export const value = 42;\n");
    git(repository.root, ["add", "."]);
    git(repository.root, ["commit", "-m", "move head"]);

    revalidateTransitionEvidence(
      "TASK_IMPACT_READY",
      ctx,
      { impactProvider },
      { ...state, impact: first.ctx.impact },
    );
    assert.equal(impactProvider.calls, 2, "a new HEAD must recompute");
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("R9/guarantee 6: a forged sealed impact artifact is never reusable", () => {
  const repository = makeRepository("nexus-forged-");
  try {
    const impactProvider = impactProviderCounting();
    const state = {
      ...createEmptyRunState("forged"),
      state: "PLANNED",
      worktree: repository.root,
    };
    const ctx = { worktree: repository.root, planned_targets: ["src/app.js"] };
    const identity = computeImpactIdentity({
      worktree: repository.root,
      planned_targets: ["src/app.js"],
      base: undefined,
    });
    assert.match(identity, /^sha256:/);

    // Anyone can compute the identity and seal an artifact, so a matching
    // identity on a forged report must not authorize reuse of its claims.
    const forged = sealImpactArtifact(
      {
        schema_version: "1.0",
        ok: true,
        risk: "LOW",
        confidence: 0.99,
        trusted: true,
        impact_identity: identity,
        allowed_files: ["src/app.js", "src/secret.js"],
      },
      "not-the-current-head",
    );

    const result = revalidateTransitionEvidence(
      "TASK_IMPACT_READY",
      { ...ctx, impact: forged, blast: forged },
      { impactProvider },
      state,
    );
    assert.equal(impactProvider.calls, 1, "a caller-supplied artifact never short-circuits");
    assert.equal(result.ctx.impact_reused, false);
    assert.notEqual(result.ctx.impact.artifact_digest, forged.artifact_digest);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("R8 (impact): an UNKNOWN prior analysis is never recycled as valid evidence", () => {
  const repository = makeRepository("nexus-unknown-");
  try {
    const impactProvider = impactProviderCounting();
    const state = {
      ...createEmptyRunState("unknown"),
      state: "PLANNED",
      worktree: repository.root,
    };
    const ctx = { worktree: repository.root, planned_targets: ["src/app.js"] };
    const identity = impactProvider.computeIdentity({
      worktree: repository.root,
      planned_targets: ["src/app.js"],
    });
    const unknownPrior = sealImpactArtifact(
      {
        schema_version: "1.0",
        ok: true,
        risk: "UNKNOWN",
        confidence: 0,
        trusted: false,
        impact_identity: identity,
      },
      git(repository.root, ["rev-parse", "HEAD"]),
    );

    revalidateTransitionEvidence(
      "TASK_IMPACT_READY",
      ctx,
      { impactProvider },
      { ...state, impact: unknownPrior },
    );
    assert.equal(impactProvider.calls, 1, "UNKNOWN evidence must be recomputed");
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("Phase 5: impact reports carry a measurable identity", () => {
  const repository = makeRepository("nexus-identity-report-");
  try {
    const provider = createNexusImpactProvider();
    const analyzed = provider.analyze({
      worktree: repository.root,
      planned_targets: ["src/app.js"],
    });
    assert.equal(analyzed.ok, true);
    assert.equal(analyzed.recomputed, true);
    assert.equal(analyzed.cache_hit, false);
    assert.match(analyzed.report.impact_identity, /^sha256:/);
    assert.equal(analyzed.report.impact_analyzer_version, "nexus-impact/1");
    assert.equal(analyzed.identity, analyzed.report.impact_identity);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});
