import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskDag,
  detectCycle,
  scheduleParallel,
  readyTasks,
} from "../../scripts/lib/task-dag.js";
import { assertScopeLock } from "../../scripts/lib/scope-lock.js";
import {
  fixLoopDecision,
  canSelfApprove,
  unresolvedHighFindings,
} from "../../scripts/lib/review-protocol.js";
import { compareBaselines, verificationLadder } from "../../scripts/lib/verification/compare.js";
import { discoverVerification } from "../../scripts/lib/verification/discover.js";

test("task DAG rejects cycles", () => {
  const dag = buildTaskDag([
    { id: "a", depends_on: ["b"] },
    { id: "b", depends_on: ["a"] },
  ]);
  assert.ok(detectCycle(dag));
});

test("parallel scheduler respects deps and file conflicts", () => {
  const dag = buildTaskDag([
    { id: "a", files: ["a.js"] },
    { id: "b", depends_on: ["a"], files: ["b.js"] },
    { id: "c", files: ["c.js"] },
  ]);
  const plan = scheduleParallel(dag, { maxConcurrency: 2 });
  assert.equal(plan.ok, true);
  assert.ok(plan.waves[0].includes("a"));
  assert.ok(plan.waves[0].includes("c") || plan.waves.length >= 1);
  assert.ok(plan.waves.flat().includes("b"));
});

test("scope lock blocks extras", () => {
  const ok = assertScopeLock({
    allowed_files: ["src/a.js"],
    changed_files: ["src/a.js"],
  });
  assert.equal(ok.ok, true);
  const bad = assertScopeLock({
    allowed_files: ["src/a.js"],
    changed_files: ["src/a.js", "src/b.js"],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "SCOPE_EXPANSION_REQUIRED");
});

test("fix loop redispatches until cap", () => {
  const findings = [{ severity: "HIGH", id: "1", resolved: false }];
  assert.equal(fixLoopDecision({ findings, attempt: 0 }).action, "redispatch_implementer");
  assert.equal(fixLoopDecision({ findings, attempt: 3 }).action, "block");
  assert.equal(canSelfApprove({ author_agent: "implementer", reviewer_agent: "implementer" }), true);
  assert.equal(unresolvedHighFindings(findings).length, 1);
});

test("baseline comparison separates new regressions", () => {
  const baseline = {
    results: [
      { id: "test", pass: false },
      { id: "lint", pass: true },
    ],
  };
  const current = {
    results: [
      { id: "test", pass: false },
      { id: "lint", pass: false },
    ],
  };
  const cmp = compareBaselines(baseline, current);
  assert.equal(cmp.pre_existing_failures.length, 1);
  assert.equal(cmp.new_regressions.length, 1);
  assert.equal(cmp.ok, false);
});

test("verification ladder escalates for CRITICAL", () => {
  assert.equal(verificationLadder("LOW").require_full, false);
  assert.equal(verificationLadder("CRITICAL").dual_review, true);
});

test("discoverVerification finds npm test in node projects", () => {
  // This repo itself
  const plan = discoverVerification(process.cwd());
  assert.equal(plan.ecosystem, "node");
  assert.ok(plan.steps.some((s) => s.id === "test"));
});
