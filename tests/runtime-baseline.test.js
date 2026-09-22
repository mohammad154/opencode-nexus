/**
 * Runtime regression fixtures (plan §27).
 *
 * These assert *work counts*, never milliseconds, so they stay stable on slow
 * or loaded machines. A fixture failing means Nexus started repeating work for
 * an evidence identity it already measured, or stopped doing required work.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import { runVerificationLifecycle } from "../scripts/lib/verification-lifecycle.js";
import { createVerificationProvider } from "../scripts/lib/providers/verification-provider.js";
import { createMetricsTelemetry } from "../scripts/lib/providers.js";
import { agentCostModel } from "../scripts/lib/agent-estimate.js";
import { planAdvisorDecision } from "../scripts/lib/planning.js";
import { goodImplementerHandoff } from "./helpers/gate-fixtures.js";

const TIMEOUTS = Object.freeze({
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

function makeRepository(prefix) {
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

function countingCommands(labels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-fixture-cmd-"));
  const steps = labels.map(({ id, kind }) => {
    const counter = path.join(dir, `${id}.log`);
    const script = path.join(dir, `${id}.cjs`);
    fs.writeFileSync(
      script,
      `require("fs").appendFileSync(${JSON.stringify(counter)}, "x\\n");\n`,
    );
    return { id, kind, command: process.execPath, args: [script], counter };
  });
  return {
    dir,
    plan() {
      return steps.map(({ id, kind, command, args }) => ({ id, kind, command, args }));
    },
    executions(id) {
      const entry = steps.find((step) => step.id === id);
      if (!fs.existsSync(entry.counter)) return 0;
      return fs.readFileSync(entry.counter, "utf8").split("\n").filter(Boolean).length;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function providers(steps, telemetry) {
  const real = createVerificationProvider();
  return {
    telemetry,
    impactProvider: {
      analyze() {
        return { ok: true, report: { ok: true, risk: "LOW", related_tests: [] } };
      },
    },
    verificationProvider: {
      resolveTimeouts() {
        return { ...TIMEOUTS };
      },
      discover() {
        return { steps: steps.map((step) => ({ ...step })) };
      },
      run(ctx) {
        return real.run({ ...ctx, timeouts: TIMEOUTS });
      },
      compare() {
        return { ok: true, new_regressions: [] };
      },
    },
  };
}

test("fixture H: single-unit task→final verification at one identity does no duplicate work", () => {
  const repository = makeRepository("nexus-fixture-h-");
  const commands = countingCommands([
    { id: "test", kind: "test" },
    { id: "lint", kind: "lint" },
  ]);
  const telemetry = createMetricsTelemetry({ enabled: false, units: 1 });
  try {
    const runId = "fixture-h";
    const taskRun = runVerificationLifecycle({
      worktree: repository.root,
      state: {
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
      },
      providers: providers(commands.plan(), telemetry),
    });
    assert.equal(taskRun.ok, true, taskRun.error);

    const finalRun = runVerificationLifecycle({
      worktree: repository.root,
      state: {
        ...createEmptyRunState(runId),
        state: "FINAL_VERIFYING",
        worktree: repository.root,
        head_commit: repository.base,
        implementer_commit: repository.head,
        last_final_review_handoff: { reviewed_commit: repository.head },
        last_review_handoff: { reviewed_commit: repository.head },
        provider_verification: taskRun.verification,
        verification_policy: { exempt: false, reason: null },
      },
      providers: providers(commands.plan(), telemetry),
    });
    assert.equal(finalRun.ok, true, finalRun.error);

    // Work counts, not timings.
    assert.equal(commands.executions("test"), 1, "full test suite runs once");
    assert.equal(commands.executions("lint"), 1, "lint runs once");

    const diagnostics = telemetry.getDuplicateWork();
    assert.equal(diagnostics.duplicate_commands, 0, "no duplicate authoritative command");
    assert.equal(diagnostics.verification_commands, 2, "two distinct checks executed");
    assert.equal(diagnostics.verification_reuse_count, 2, "both reused at final");

    // Required evidence is still complete at the final phase.
    assert.equal(finalRun.verification.ok, true);
    assert.equal(finalRun.verification.results.length, 2);
    assert.equal(finalRun.verification.reused_steps, 2);
    assert.equal(finalRun.verification.ran_steps, 0);
  } finally {
    commands.cleanup();
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("fixture A/B: compact one-unit work stays at implementer + reviewer", () => {
  const compact = agentCostModel({ units: 1, planningMode: "compact" });
  assert.equal(compact.calls.plan_advisor, 0, "compact plans use no advisor");
  assert.equal(compact.calls.implementer, 1);
  assert.equal(compact.calls.task_reviewer, 1);
  assert.equal(
    compact.calls.total,
    2 + compact.calls.final_reviewer,
    "no extra agent calls beyond implementer, reviewer, and the final reviewer",
  );

  const compactWithReuse = agentCostModel({
    units: 1,
    planningMode: "compact",
    singleUnitFinalReviewReuse: true,
  });
  assert.equal(compactWithReuse.calls.total, 2, "eligible single-unit reuse reaches the §30 target");
});

test("fixture C/D: a clear standard task spends no advisor call", () => {
  // PR4: planning depth and independent planning challenge are separate
  // variables. A cohesive, known-pattern standard unit records a deterministic
  // `plan_advisor_decision` and saves the call.
  const decision = planAdvisorDecision({
    planning_mode: "standard",
    unit_count: 1,
    cohesive_unit: true,
    known_pattern: true,
    risk: "LOW",
  });
  assert.equal(decision.required, false);

  const clear = agentCostModel({
    units: 1,
    planningMode: "standard",
    advisorDecision: decision,
  });
  assert.equal(clear.calls.plan_advisor, 0);
  assert.equal(clear.calls.implementer, 1);
  assert.equal(clear.calls.task_reviewer, 1);

  // Without a recorded decision the estimate stays conservative.
  const conservative = agentCostModel({ units: 1, planningMode: "standard" });
  assert.equal(conservative.calls.plan_advisor, 1);
  assert.equal(conservative.calls.total - clear.calls.total, 1);

  // Ambiguous or high-risk planning is unchanged.
  const ambiguous = planAdvisorDecision({
    planning_mode: "standard",
    unit_count: 1,
    cohesive_unit: true,
    known_pattern: true,
    risk: "HIGH",
  });
  assert.equal(ambiguous.required, true);
  assert.equal(
    agentCostModel({ units: 1, planningMode: "standard", advisorDecision: ambiguous })
      .calls.plan_advisor,
    1,
  );

  const multi = agentCostModel({ units: 3, planningMode: "standard" });
  assert.equal(multi.calls.implementer, 3);
  assert.equal(multi.calls.task_reviewer, 3);
  assert.equal(multi.calls.final_reviewer, 1);
});

test("fixture F: a remediation loop adds one implementer and one reviewer call", () => {
  const clean = agentCostModel({ units: 1, planningMode: "compact" });
  const repaired = agentCostModel({ units: 1, planningMode: "compact", fixLoops: 1 });
  assert.equal(repaired.calls.implementer - clean.calls.implementer, 1);
  assert.equal(repaired.calls.task_reviewer - clean.calls.task_reviewer, 1);
});
