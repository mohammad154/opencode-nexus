import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canTransition } from "../scripts/lib/state-machine.js";
import {
  acceptedReviewerTimeout,
  convergenceErrors,
  convergenceReport,
} from "../scripts/lib/traceability.js";
import { readReviewerTimeouts, recordSubagentTimeout } from "../scripts/lib/subagent-budget.js";
import { assessToolEdit } from "../scripts/lib/orchestrator-edit.js";
import { protectedRunDir } from "../scripts/lib/protected-state.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEAD = "a".repeat(40);
const OLD = "2026-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

const UNITS = [
  { id: "unit-1", acceptance_criteria: ["sum clamps to max"], allowed_files: ["src/sum.js"] },
  { id: "unit-2", acceptance_criteria: ["avg clamps to max"], allowed_files: ["src/avg.js"] },
];

const CONVERGENCE = /planned execution unit|planned criterion|declared requirement/;

function reviewHandoff(unit, createdAt = OLD, verdict = "APPROVED") {
  const handoff = {
    schema_version: "1.2",
    run_id: "conv",
    unit_or_task: unit,
    agent: "reviewer",
    base_commit: "b".repeat(40),
    verdict,
    review_scope: "task",
    reviewed_commit: HEAD,
    files_reviewed: ["src/sum.js"],
    impact: { pass: true, risk: "LOW" },
    acceptance: [
      {
        id: `${unit}/AC1`,
        criterion: UNITS.find((u) => u.id === unit).acceptance_criteria[0],
        status: "PASS",
        evidence: [{ file: "src/sum.js", line: 3, reason: "clamped" }],
      },
    ],
    checks: [
      { category: "correctness", status: "PASS", evidence: "src/sum.js:3" },
      { category: "test_quality", status: "PASS", evidence: "tests/sum.test.js:9" },
      { category: "impact", status: "PASS", evidence: "only the test calls it" },
    ],
    findings: [],
  };
  if (createdAt !== null) handoff.created_at = createdAt;
  return handoff;
}

function approvedEntry(unit, createdAt = OLD) {
  return {
    id: unit,
    verdict: "APPROVED",
    reviewed_commit: HEAD,
    acceptance_criteria: UNITS.find((u) => u.id === unit).acceptance_criteria,
    review_handoff: reviewHandoff(unit, createdAt),
  };
}

function requestChangesEntry(unit, createdAt) {
  return {
    id: unit,
    verdict: "REQUEST_CHANGES",
    reviewed_commit: HEAD,
    acceptance_criteria: UNITS.find((u) => u.id === unit).acceptance_criteria,
    review_handoff: reviewHandoff(unit, createdAt, "REQUEST_CHANGES"),
  };
}

function finalVerifyingState(overrides = {}) {
  return {
    run_id: "conv",
    state: "FINAL_VERIFYING",
    execution_units: UNITS,
    units: UNITS,
    tasks: UNITS,
    task_count: 2,
    current_unit: "unit-2",
    acceptance_criteria: ["avg clamps to max"],
    branch: "feat/conv",
    head_commit: HEAD,
    verification_status: "PASSED",
    task_history: [approvedEntry("unit-1")],
    ...overrides,
  };
}

function makeWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-reviewer-timeout-"));
}

function timeoutFile(worktree, runId) {
  return path.join(protectedRunDir(worktree, runId), "subagent-timeouts.json");
}

function writeTimeoutFile(worktree, runId, document) {
  fs.mkdirSync(path.dirname(timeoutFile(worktree, runId)), { recursive: true });
  fs.writeFileSync(timeoutFile(worktree, runId), JSON.stringify(document, null, 2));
}

function timeoutRecord(overrides = {}) {
  return {
    status: "TIMED_OUT",
    role: "reviewer",
    run_id: "conv",
    unit: "unit-2",
    attempts: 1,
    exhausted: false,
    at: new Date().toISOString(),
    call_id: "call-1",
    ...overrides,
  };
}

function convergenceLines(result) {
  return result.errors.filter((error) => CONVERGENCE.test(error));
}

test("a run-scoped reviewer timeout is the terminal review outcome for its unit and warns", () => {
  const worktree = makeWorktree();
  try {
    recordSubagentTimeout(worktree, { run_id: "conv", role: "reviewer", unit: "unit-2", callID: "call-1" });
    const state = finalVerifyingState();

    const report = convergenceReport(state, {
      label: "COMPLETED",
      reviewerTimeouts: readReviewerTimeouts(worktree, "conv", ["unit-1", "unit-2"]),
    });
    assert.deepEqual(report.errors, []);
    assert.equal(report.accepted_timeouts.length, 1);
    assert.equal(report.accepted_timeouts[0].unit, "unit-2");
    assert.match(report.warnings.join("\n"), /unit-2 has no approved review; its reviewer timed out/);

    const result = canTransition(state, "COMPLETED", { worktree });
    assert.deepEqual(convergenceLines(result), []);
    assert.match(result.warnings.join("\n"), /unit-2 has no approved review/);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("without a recorded timeout the gate still rejects the missing review", () => {
  const worktree = makeWorktree();
  try {
    const result = canTransition(finalVerifyingState(), "COMPLETED", { worktree });
    assert.equal(result.ok, false);
    assert.match(convergenceLines(result).join(" | "), /requires an approved task review .*missing: unit-2/);
    assert.equal(result.warnings.length, 0);
    assert.match(convergenceErrors(finalVerifyingState(), { label: "COMPLETED" }).join(" | "), /missing: unit-2/);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("a timeout file outside the run directory is never trusted", () => {
  const worktree = makeWorktree();
  try {
    fs.mkdirSync(path.join(worktree, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(worktree, ".opencode", "subagent-timeouts.json"),
      JSON.stringify({ run_id: "conv", records: { a: timeoutRecord() } }),
    );
    assert.deepEqual(readReviewerTimeouts(worktree, "conv", ["unit-2"]), {});
    const result = canTransition(finalVerifyingState(), "COMPLETED", { worktree });
    assert.match(convergenceLines(result).join(" | "), /missing: unit-2/);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("a record that names another run is rejected even inside this run's file", () => {
  const worktree = makeWorktree();
  try {
    writeTimeoutFile(worktree, "conv", {
      run_id: "conv",
      records: { "unit-2:reviewer:call-1": timeoutRecord({ run_id: "other-run" }) },
    });
    assert.deepEqual(readReviewerTimeouts(worktree, "conv", ["unit-2"]), {});
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("a document that names another run cannot be placed at this run's path", () => {
  const worktree = makeWorktree();
  try {
    writeTimeoutFile(worktree, "conv", {
      run_id: "other-run",
      records: { "unit-2:reviewer:call-1": timeoutRecord({ run_id: "other-run" }) },
    });
    assert.deepEqual(readReviewerTimeouts(worktree, "conv", ["unit-2"]), {});
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("a timeout recorded for another unit does not cover this unit", () => {
  const worktree = makeWorktree();
  try {
    recordSubagentTimeout(worktree, { run_id: "conv", role: "reviewer", unit: "unit-1", callID: "call-1" });
    const result = canTransition(finalVerifyingState(), "COMPLETED", { worktree });
    assert.match(convergenceLines(result).join(" | "), /missing: unit-2/);
    assert.equal(result.warnings.length, 0);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("a timeout without a readable timestamp is rejected", () => {
  const state = finalVerifyingState();
  assert.equal(acceptedReviewerTimeout(state, "unit-2", timeoutRecord({ at: undefined })), false);
  assert.equal(acceptedReviewerTimeout(state, "unit-2", timeoutRecord({ at: "not-a-date" })), false);
});

test("an implementer timeout cannot stand in for a missing reviewer verdict", () => {
  const state = finalVerifyingState();
  assert.equal(acceptedReviewerTimeout(state, "unit-2", timeoutRecord({ role: "implementer" })), false);
});

test("a record that is not TIMED_OUT or names no unit is rejected", () => {
  const state = finalVerifyingState();
  assert.equal(acceptedReviewerTimeout(state, "unit-2", timeoutRecord({ status: "DONE" })), false);
  assert.equal(acceptedReviewerTimeout(state, "unit-2", timeoutRecord({ unit: undefined })), false);
  assert.equal(acceptedReviewerTimeout(state, "unit-2", null), false);
});

test("a real REQUEST_CHANGES newer than the timeout blocks it", () => {
  const worktree = makeWorktree();
  try {
    recordSubagentTimeout(worktree, { run_id: "conv", role: "reviewer", unit: "unit-2", callID: "call-1" });
    const state = finalVerifyingState({
      task_history: [approvedEntry("unit-1"), requestChangesEntry("unit-2", FUTURE)],
    });
    const result = canTransition(state, "COMPLETED", { worktree });
    assert.match(convergenceLines(result).join(" | "), /missing: unit-2/);
    assert.equal(result.warnings.length, 0);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("a REQUEST_CHANGES older than the timeout does not block a later timeout", () => {
  const worktree = makeWorktree();
  try {
    recordSubagentTimeout(worktree, { run_id: "conv", role: "reviewer", unit: "unit-2", callID: "call-1" });
    const state = finalVerifyingState({
      task_history: [approvedEntry("unit-1"), requestChangesEntry("unit-2", OLD)],
    });
    const result = canTransition(state, "COMPLETED", { worktree });
    assert.deepEqual(convergenceLines(result), []);
    assert.match(result.warnings.join("\n"), /unit-2 has no approved review/);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("a review without a readable time keeps the timeout from being accepted", () => {
  const worktree = makeWorktree();
  try {
    recordSubagentTimeout(worktree, { run_id: "conv", role: "reviewer", unit: "unit-2", callID: "call-1" });
    const state = finalVerifyingState({
      task_history: [approvedEntry("unit-1"), requestChangesEntry("unit-2", null)],
    });
    const result = canTransition(state, "COMPLETED", { worktree });
    assert.match(convergenceLines(result).join(" | "), /missing: unit-2/);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("a timeout does not waive a failed criterion on a unit that was approved", () => {
  const worktree = makeWorktree();
  try {
    recordSubagentTimeout(worktree, { run_id: "conv", role: "reviewer", unit: "unit-1", callID: "call-1" });
    const partial = approvedEntry("unit-2");
    partial.review_handoff.acceptance = [{ id: "unit-2/AC1", status: "CANNOT_VERIFY", evidence: [] }];
    const state = finalVerifyingState({
      task_history: [partial],
      current_unit: "unit-1",
    });
    const result = canTransition(state, "COMPLETED", { worktree });
    const lines = convergenceLines(result).join(" | ");
    assert.match(lines, /passing acceptance result for every planned criterion; missing: unit-2\/AC1/);
    assert.doesNotMatch(lines, /approved task review/);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("a single-unit planned run accepts its own reviewer timeout with a warning", () => {
  const worktree = makeWorktree();
  try {
    recordSubagentTimeout(worktree, { run_id: "conv", role: "reviewer", unit: "unit-1", callID: "call-1" });
    const state = finalVerifyingState({
      execution_units: [UNITS[0]],
      units: [UNITS[0]],
      tasks: [UNITS[0]],
      task_count: 1,
      current_unit: "unit-1",
      acceptance_criteria: ["sum clamps to max"],
      task_history: [],
    });
    const result = canTransition(state, "COMPLETED", { worktree });
    assert.deepEqual(convergenceLines(result), []);
    assert.match(result.warnings.join("\n"), /unit-1 has no approved review/);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("an accepted timeout does not waive sealed final verification", () => {
  const worktree = makeWorktree();
  try {
    recordSubagentTimeout(worktree, { run_id: "conv", role: "reviewer", unit: "unit-2", callID: "call-1" });
    const result = canTransition(finalVerifyingState(), "COMPLETED", { worktree });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" | "), /COMPLETED requires sealed final_verification\.ok from nexus verify/);
    assert.match(result.errors.join(" | "), /COMPLETED requires sealed final_post_impact from nexus verify/);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("implementer bash cannot forge or read run-scoped timeout records", () => {
  const forgery = `node -e "require('fs').writeFileSync('.opencode/runs/conv/subagent-timeouts.json','{}')"`;
  const protectedForgery = `echo '{}' > ${protectedRunDir("/workspace", "conv")}/subagent-timeouts.json`;
  for (const command of [
    "echo '{}' > .opencode/runs/conv/subagent-timeouts.json",
    "cat .opencode/runs/conv/state.json",
    "sed -i 's/x/y/' ./.opencode/runs/conv/subagent-timeouts.json",
    "cp /tmp/x.json subagent-timeouts.json",
    "cat ~/.local/state/nexus-control/worktrees/abc/runs/conv/subagent-timeouts.json",
    protectedForgery,
    forgery,
  ]) {
    const decision = assessToolEdit({
      agent: "implementer",
      worktree: "/workspace",
      input: { tool: "bash" },
      args: { command },
    });
    assert.equal(decision?.ok, false, `expected deny for: ${command}`);
  }
  for (const command of ["npm test", "git status --porcelain", "node --test tests/"]) {
    const decision = assessToolEdit({
      agent: "implementer",
      worktree: "/workspace",
      input: { tool: "bash" },
      args: { command },
    });
    assert.equal(decision?.ok, true, `expected allow for: ${command}`);
  }
});

test("the implementer frontmatter denies run-scoped timeout paths for bash", () => {
  const implementer = fs.readFileSync(path.join(repoRoot, "agents", "implementer.md"), "utf8");
  const bash = implementer.match(/\n  bash:\n((?:    .*\n)+)/)?.[1] || "";
  assert.ok(bash.includes(`"*.opencode/runs*": deny`));
  assert.ok(bash.includes(`"*subagent-timeouts*": deny`));
});
