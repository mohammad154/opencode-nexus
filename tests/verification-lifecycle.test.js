import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createEmptyRunState,
  readRunState,
  writeRunState,
} from "../scripts/lib/migrate-artifacts.js";
import { canTransition } from "../scripts/lib/state-machine.js";
import {
  runVerificationLifecycle,
  verificationArtifactPath,
} from "../scripts/lib/verification-lifecycle.js";
import { resolveNextAction } from "../scripts/lib/next-action.js";
import { sealProviderArtifact } from "../scripts/lib/artifact-seal.js";
import { compareBaselines } from "../scripts/lib/verification/compare.js";
import { goodImplementerHandoff } from "./helpers/gate-fixtures.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TIMEOUTS = Object.freeze({
  targetedTest: 100,
  fullTest: 100,
  lint: 100,
  typecheck: 100,
  build: 100,
});

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr || result.stdout}`);
  return String(result.stdout || "").trim();
}

function makeRepository(prefix = "nexus-verification-") {
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
  const head = git(root, ["rev-parse", "HEAD"]);
  return { root, base, head };
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

function plan(ids = ["test"]) {
  return {
    steps: ids.map((id) => ({
      id,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      kind: "test",
    })),
  };
}

function passedRun(ctx) {
  const reusable = new Map((ctx.reuse_results || []).map((result) => [result.id, result]));
  const results = [];
  const steps = ctx.plan.steps || [];
  for (const [offset, step] of steps.entries()) {
    const index = offset + 1;
    const cached = reusable.get(step.id);
    if (cached) {
      const result = { ...cached, id: step.id, pass: true, status: "REUSED" };
      results.push(result);
      ctx.onProgress?.({ type: "reuse", index, total: steps.length, step, result });
      continue;
    }
    ctx.onProgress?.({ type: "start", index, total: steps.length, step });
    const result = { id: step.id, exit_code: 0, pass: true, status: "PASSED" };
    results.push(result);
    ctx.onProgress?.({ type: "complete", index, total: steps.length, step, result });
  }
  return { ok: results.length > 0, results, plan: ctx.plan, timed_out: false };
}

function providers({
  verificationPlan = plan(),
  run = passedRun,
  impactReport = { ok: true, risk: "LOW", related_tests: [] },
  verifyTdd = null,
} = {}) {
  return {
    impactProvider: {
      analyze() {
        return { ok: impactReport.ok !== false, report: impactReport };
      },
    },
    verificationProvider: {
      resolveTimeouts() {
        return { ...TIMEOUTS };
      },
      discover() {
        return verificationPlan;
      },
      run,
      compare() {
        return { ok: true, new_regressions: [] };
      },
      ...(verifyTdd ? { verifyTdd } : {}),
    },
  };
}

test("workflow-aware task verification persists sealed evidence and opens REVIEWING", () => {
  const repository = makeRepository();
  try {
    const state = taskState("verify-pass", repository);
    writeRunState(repository.root, state);
    const result = runVerificationLifecycle({
      worktree: repository.root,
      state,
      providers: providers(),
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.state.state, "VERIFYING");
    assert.equal(result.state.verification_status, "PASSED");
    assert.equal(result.state.verification.phase, "TASK");
    assert.ok(result.state.post_impact?.provider_validated);
    assert.ok(result.state.provider_verification?.provider_validated);
    assert.equal(result.state.provider_verification.ok, true);
    assert.ok(fs.existsSync(verificationArtifactPath(repository.root, state.run_id)));
    assert.equal(
      canTransition(result.state, "REVIEWING", { worktree: repository.root }).ok,
      true,
    );
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("failed deterministic verification stays in VERIFYING and blocks the reviewer", () => {
  const repository = makeRepository();
  try {
    const state = taskState("verify-fail", repository);
    writeRunState(repository.root, state);
    const result = runVerificationLifecycle({
      worktree: repository.root,
      state,
      providers: providers({
        run(ctx) {
          const step = ctx.plan.steps[0];
          ctx.onProgress?.({ type: "start", index: 1, total: 1, step });
          const failed = { id: step.id, exit_code: 1, pass: false, status: "FAILED" };
          ctx.onProgress?.({ type: "complete", index: 1, total: 1, step, result: failed });
          return { ok: false, results: [failed], plan: ctx.plan, timed_out: false };
        },
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.state.state, "VERIFYING");
    assert.equal(result.state.verification_status, "FAILED");
    assert.equal(
      canTransition(result.state, "REVIEWING", { worktree: repository.root }).ok,
      false,
    );
    assert.equal(resolveNextAction(result.state).action, "report_failed_verification");
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("timeout remains resumable in VERIFYING and does not redispatch an implementer", () => {
  const repository = makeRepository();
  try {
    const state = taskState("verify-timeout", repository);
    writeRunState(repository.root, state);
    const result = runVerificationLifecycle({
      worktree: repository.root,
      state,
      providers: providers({
        run(ctx) {
          const step = ctx.plan.steps[0];
          ctx.onProgress?.({ type: "start", index: 1, total: 1, step });
          const timedOut = {
            id: step.id,
            exit_code: null,
            pass: false,
            status: "TIMED_OUT",
            timed_out: true,
          };
          ctx.onProgress?.({ type: "complete", index: 1, total: 1, step, result: timedOut });
          return { ok: false, timed_out: true, results: [timedOut], plan: ctx.plan };
        },
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "VERIFICATION_TIMED_OUT");
    assert.equal(result.state.state, "VERIFYING");
    assert.equal(result.state.verification_status, "TIMED_OUT");
    const next = resolveNextAction(result.state);
    assert.equal(next.action, "resume_verification");
    assert.equal(next.command, "nexus verify --resume");
    assert.equal(next.agent, null);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("resume reuses only passed steps when HEAD, plan, and configuration match", () => {
  const repository = makeRepository();
  try {
    const state = taskState("verify-resume", repository);
    writeRunState(repository.root, state);
    let attempt = 0;
    const executed = [];
    const provider = providers({
      verificationPlan: plan(["first", "second"]),
      run(ctx) {
        attempt += 1;
        const reusable = new Map((ctx.reuse_results || []).map((item) => [item.id, item]));
        const results = [];
        for (const [offset, step] of ctx.plan.steps.entries()) {
          const index = offset + 1;
          const cached = reusable.get(step.id);
          if (cached) {
            const reused = { ...cached, id: step.id, pass: true, status: "REUSED" };
            results.push(reused);
            ctx.onProgress?.({ type: "reuse", index, total: 2, step, result: reused });
            continue;
          }
          executed.push(`${attempt}:${step.id}`);
          ctx.onProgress?.({ type: "start", index, total: 2, step });
          const timeout = attempt === 1 && step.id === "second";
          const result = timeout
            ? { id: step.id, exit_code: null, pass: false, status: "TIMED_OUT", timed_out: true }
            : { id: step.id, exit_code: 0, pass: true, status: "PASSED" };
          results.push(result);
          ctx.onProgress?.({ type: "complete", index, total: 2, step, result });
          if (timeout) return { ok: false, timed_out: true, results, plan: ctx.plan };
        }
        return { ok: true, results, plan: ctx.plan, timed_out: false };
      },
    });

    const first = runVerificationLifecycle({ worktree: repository.root, state, providers: provider });
    assert.equal(first.code, "VERIFICATION_TIMED_OUT");
    const resumed = runVerificationLifecycle({
      worktree: repository.root,
      state: first.state,
      providers: provider,
      resume: true,
    });

    assert.equal(resumed.ok, true, resumed.error);
    assert.deepEqual(executed, ["1:first", "1:second", "2:second"]);
    assert.equal(resumed.state.verification_status, "PASSED");
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("resume rejects cached results after a changed HEAD", () => {
  const repository = makeRepository();
  try {
    const state = taskState("verify-head-change", repository);
    writeRunState(repository.root, state);
    let executions = 0;
    const provider = providers({
      run(ctx) {
        executions += 1;
        const step = ctx.plan.steps[0];
        ctx.onProgress?.({ type: "start", index: 1, total: 1, step });
        const timedOut = { id: step.id, exit_code: null, pass: false, status: "TIMED_OUT", timed_out: true };
        ctx.onProgress?.({ type: "complete", index: 1, total: 1, step, result: timedOut });
        return { ok: false, timed_out: true, results: [timedOut], plan: ctx.plan };
      },
    });
    const first = runVerificationLifecycle({ worktree: repository.root, state, providers: provider });
    assert.equal(first.code, "VERIFICATION_TIMED_OUT");

    fs.writeFileSync(path.join(repository.root, "src", "app.js"), "export const value = 3;\n");
    git(repository.root, ["add", "src/app.js"]);
    git(repository.root, ["commit", "-m", "unexpected head change"]);
    const resumed = runVerificationLifecycle({
      worktree: repository.root,
      state: first.state,
      providers: provider,
      resume: true,
    });

    assert.equal(resumed.ok, false);
    assert.equal(resumed.code, "HEAD_MISMATCH");
    assert.equal(resumed.state.state, "VERIFYING");
    assert.equal(resumed.state.verification_status, "FAILED");
    assert.equal(executions, 1, "no cached step may execute against a different HEAD");
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("tampered durable verification artifact is not reused", () => {
  const repository = makeRepository();
  try {
    const state = taskState("verify-tamper", repository);
    writeRunState(repository.root, state);
    let invocation = 0;
    const reuseCounts = [];
    const provider = providers({
      run(ctx) {
        invocation += 1;
        reuseCounts.push((ctx.reuse_results || []).length);
        const step = ctx.plan.steps[0];
        ctx.onProgress?.({ type: "start", index: 1, total: 1, step });
        const result = invocation === 1
          ? { id: step.id, exit_code: null, pass: false, status: "TIMED_OUT", timed_out: true }
          : { id: step.id, exit_code: 0, pass: true, status: "PASSED" };
        ctx.onProgress?.({ type: "complete", index: 1, total: 1, step, result });
        return {
          ok: invocation > 1,
          timed_out: invocation === 1,
          results: [result],
          plan: ctx.plan,
        };
      },
    });
    const first = runVerificationLifecycle({ worktree: repository.root, state, providers: provider });
    const file = verificationArtifactPath(repository.root, state.run_id);
    const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
    artifact.steps.push({ id: "forged-pass", provider_step: true, pass: true, status: "PASSED" });
    fs.writeFileSync(file, JSON.stringify(artifact, null, 2));

    const resumed = runVerificationLifecycle({
      worktree: repository.root,
      state: first.state,
      providers: provider,
      resume: true,
    });
    assert.equal(resumed.ok, true, resumed.error);
    assert.deepEqual(reuseCounts, [0, 0]);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("zero executable checks fail closed and caller-forged verification cannot open REVIEWING", () => {
  const repository = makeRepository();
  try {
    const state = taskState("verify-unavailable", repository);
    writeRunState(repository.root, state);
    const result = runVerificationLifecycle({
      worktree: repository.root,
      state,
      providers: providers({
        run(ctx) {
          return { ok: false, code: "VERIFICATION_UNAVAILABLE", results: [], plan: ctx.plan };
        },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "VERIFICATION_UNAVAILABLE");
    assert.equal(result.state.verification_status, "FAILED");

    const forged = canTransition(result.state, "REVIEWING", {
      provider_verification: sealProviderArtifact({ ok: true, results: [{ pass: true }] }, repository.head),
    });
    assert.equal(forged.ok, false);
    assert.ok(forged.errors.some((error) => /caller-supplied provider_verification/i.test(error)));
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("baseline comparison waives only known executed failures, never an unavailable run", () => {
  const repository = makeRepository();
  try {
    const baseline = { results: [{ id: "test", pass: false }] };
    const knownFailure = taskState("verify-baseline-known", repository, { baseline });
    writeRunState(repository.root, knownFailure);
    const knownProvider = providers({
      run(ctx) {
        const step = ctx.plan.steps[0];
        const failed = { id: step.id, exit_code: 1, pass: false, status: "FAILED" };
        return { ok: false, results: [failed], plan: ctx.plan, timed_out: false };
      },
    });
    knownProvider.verificationProvider.compare = compareBaselines;
    const knownResult = runVerificationLifecycle({
      worktree: repository.root,
      state: knownFailure,
      providers: knownProvider,
    });
    assert.equal(knownResult.ok, true, knownResult.error);
    assert.equal(knownResult.state.provider_verification.ok, true);
    assert.equal(
      knownResult.state.provider_verification.baseline_comparison.pre_existing_failures.length,
      1,
    );

    const unavailable = taskState("verify-baseline-unavailable", repository, { baseline });
    writeRunState(repository.root, unavailable);
    const unavailableProvider = providers({
      run(ctx) {
        return { ok: false, code: "VERIFICATION_UNAVAILABLE", results: [], plan: ctx.plan };
      },
    });
    unavailableProvider.verificationProvider.compare = compareBaselines;
    const unavailableResult = runVerificationLifecycle({
      worktree: repository.root,
      state: unavailable,
      providers: unavailableProvider,
    });
    assert.equal(unavailableResult.ok, false);
    assert.equal(unavailableResult.code, "VERIFICATION_UNAVAILABLE");
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("final verification timeout stays FINAL_VERIFYING and forbids COMPLETED", () => {
  const repository = makeRepository();
  try {
    const state = finalState("verify-final-timeout", repository);
    writeRunState(repository.root, state);
    const result = runVerificationLifecycle({
      worktree: repository.root,
      state,
      providers: providers({
        run(ctx) {
          const step = ctx.plan.steps[0];
          ctx.onProgress?.({ type: "start", index: 1, total: 1, step });
          const timedOut = { id: step.id, pass: false, status: "TIMED_OUT", timed_out: true };
          ctx.onProgress?.({ type: "complete", index: 1, total: 1, step, result: timedOut });
          return { ok: false, timed_out: true, results: [timedOut], plan: ctx.plan };
        },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "VERIFICATION_TIMED_OUT");
    assert.equal(result.state.state, "FINAL_VERIFYING");
    assert.equal(result.state.verification_status, "TIMED_OUT");
    assert.equal(resolveNextAction(result.state).action, "resume_verification");
    assert.equal(
      canTransition(result.state, "COMPLETED", { worktree: repository.root }).ok,
      false,
    );
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("TDD is measured by lifecycle, and final verification alone authorizes COMPLETED", () => {
  const repository = makeRepository();
  try {
    const task = taskState("verify-tdd", repository, {
      classification: { change_class: "bug-fix" },
      tdd_required: true,
    });
    writeRunState(repository.root, task);
    const tddProviders = providers({
      verifyTdd(ctx) {
        return sealProviderArtifact({
          ok: true,
          red: { commit: ctx.base_commit, exit_code: 1, output_digest: "sha256:red" },
          green: { commit: ctx.implementer_commit, exit_code: 0, output_digest: "sha256:green" },
        }, repository.head);
      },
    });
    const taskResult = runVerificationLifecycle({
      worktree: repository.root,
      state: task,
      providers: tddProviders,
    });
    assert.equal(taskResult.ok, true, taskResult.error);
    assert.equal(taskResult.state.tdd_evidence.ok, true);
    assert.equal(
      canTransition(taskResult.state, "REVIEWING", { worktree: repository.root }).ok,
      true,
    );

    const final = finalState("verify-final", repository);
    writeRunState(repository.root, final);
    const finalResult = runVerificationLifecycle({
      worktree: repository.root,
      state: final,
      providers: providers(),
    });
    assert.equal(finalResult.ok, true, finalResult.error);
    assert.equal(finalResult.state.state, "FINAL_VERIFYING");
    assert.equal(finalResult.state.verification_status, "PASSED");
    assert.equal(finalResult.state.final_verification.ok, true);
    assert.equal(
      canTransition(finalResult.state, "COMPLETED", { worktree: repository.root }).ok,
      true,
    );
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("a progress-persisted RUNNING state survives an interrupted verifier process", () => {
  const repository = makeRepository();
  try {
    const state = taskState("verify-interrupted", repository);
    writeRunState(repository.root, state);
    const child = path.join(repository.root, "interrupt-verification.mjs");
    const lifecycleModule = pathToFileURL(
      path.join(packageRoot, "scripts", "lib", "verification-lifecycle.js"),
    ).href;
    const migrationModule = pathToFileURL(
      path.join(packageRoot, "scripts", "lib", "migrate-artifacts.js"),
    ).href;
    fs.writeFileSync(
      child,
      [
        `import { readRunState } from ${JSON.stringify(migrationModule)};`,
        `import { runVerificationLifecycle } from ${JSON.stringify(lifecycleModule)};`,
        "const [root, runId] = process.argv.slice(2);",
        "const state = readRunState(root, runId);",
        "const providers = {",
        "  impactProvider: { analyze() { return { ok: true, report: { ok: true, risk: 'LOW', related_tests: [] } }; } },",
        "  verificationProvider: {",
        "    resolveTimeouts() { return { targetedTest: 100, fullTest: 100, lint: 100, typecheck: 100, build: 100 }; },",
        "    discover() { return { steps: [{ id: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], kind: 'test' }] }; },",
        "    run(ctx) { const step = ctx.plan.steps[0]; ctx.onProgress({ type: 'start', index: 1, total: 1, step }); return { ok: false, results: [], plan: ctx.plan }; },",
        "  },",
        "};",
        "runVerificationLifecycle({ worktree: root, state, providers, onProgress(event) { if (event.type === 'step_start') process.exit(75); } });",
      ].join("\n"),
      "utf8",
    );
    const interrupted = spawnSync(process.execPath, [child, repository.root, state.run_id], {
      cwd: repository.root,
      encoding: "utf8",
    });
    assert.equal(interrupted.status, 75, interrupted.stderr || interrupted.stdout);

    const persisted = readRunState(repository.root, state.run_id);
    assert.equal(persisted.state, "VERIFYING");
    assert.equal(persisted.verification_status, "RUNNING");
    assert.ok(fs.existsSync(verificationArtifactPath(repository.root, state.run_id)));
    assert.equal(resolveNextAction(persisted).action, "resume_verification");
    const resumed = runVerificationLifecycle({
      worktree: repository.root,
      state: persisted,
      providers: providers(),
      resume: true,
    });
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(resumed.state.verification_status, "PASSED");
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});
