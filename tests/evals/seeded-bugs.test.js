/**
 * Evaluation harness — seeded bugs must not escape critical gates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeRisk } from "../../scripts/lib/impact/risk.js";
import { computeConfidence } from "../../scripts/lib/impact/confidence.js";
import { fixLoopDecision, canSelfApprove } from "../../scripts/lib/review-protocol.js";
import { assertScopeLock } from "../../scripts/lib/scope-lock.js";

const SEEDED = [
  {
    id: "auth-bypass",
    changed_files: ["src/auth/login.js"],
    change_class: "authentication-security",
    expect_min_risk: "CRITICAL",
  },
  {
    id: "migration-drop",
    changed_files: ["db/migrations/001.sql"],
    change_class: "database-migration",
    expect_min_risk: "CRITICAL",
  },
  {
    id: "public-api-break",
    changed_files: ["packages/api/public.ts"],
    change_class: "public-api",
    changed_symbols: [{ name: "handler", exported: true }],
    expect_min_risk: "HIGH",
  },
];

const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

test("seeded critical bugs never classify below expected risk", () => {
  let escapes = 0;
  for (const seed of SEEDED) {
    const { risk } = computeRisk({
      changed_files: seed.changed_files,
      change_class: seed.change_class,
      changed_symbols: seed.changed_symbols || [],
      confidence: 0.95,
    });
    if (RANK[risk] < RANK[seed.expect_min_risk]) {
      escapes += 1;
    }
  }
  assert.equal(escapes, 0, "critical seeded bug escape must be zero");
});

test("low confidence forces stricter posture", () => {
  const c = computeConfidence({ unsupportedFiles: 3, totalFiles: 3, gitOk: true });
  assert.ok(c < 0.75);
});

test("reviewer cannot self-approve implementation", () => {
  assert.equal(
    canSelfApprove({ author_agent: "implementer-A", reviewer_agent: "implementer-A" }),
    true,
  );
  assert.equal(
    canSelfApprove({ author_agent: "implementer-A", reviewer_agent: "code-reviewer" }),
    false,
  );
});

test("scope expansion is required before out-of-scope fixes", () => {
  const r = assertScopeLock({
    allowed_files: ["src/a.js"],
    changed_files: ["src/secret.js"],
  });
  assert.equal(r.ok, false);
});

test("unresolved HIGH findings block completion path via fix loop", () => {
  const d = fixLoopDecision({
    findings: [{ severity: "HIGH", resolved: false }],
    attempt: 3,
  });
  assert.equal(d.action, "block");
});

test("empty allowed_files fails closed", () => {
  const r = assertScopeLock({ allowed_files: [], changed_files: ["a.js"] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "SCOPE_UNBOUND");
});

test("caller-shaped final_verification is not trusted without seal", async () => {
  const { canTransition } = await import("../../scripts/lib/state-machine.js");
  const { createEmptyRunState } = await import("../../scripts/lib/migrate-artifacts.js");
  const state = {
    ...createEmptyRunState("eval-fake-final"),
    state: "FINAL_VERIFYING",
    review_level: "unified",
  };
  const r = canTransition(state, "COMPLETED", {
    final_verification: { ok: true },
    skip_final_verification: true,
  });
  assert.equal(r.ok, false);
});

test("omitted tdd_required still enforces policy for bug-fix", async () => {
  const { canTransition } = await import("../../scripts/lib/state-machine.js");
  const { createEmptyRunState } = await import("../../scripts/lib/migrate-artifacts.js");
  const { goodImplementerHandoff, sealedVerification, sealedImpact } = await import(
    "../helpers/gate-fixtures.js"
  );
  const state = {
    ...createEmptyRunState("eval-tdd"),
    state: "IMPLEMENTING",
    review_level: "unified",
    execution_mode: "delegated",
    current_unit: "u1",
    head_commit: "base",
    classification: { change_class: "bug-fix", review_level: "unified" },
  };
  const r = canTransition(state, "VERIFYING", {
    provider_verification: sealedVerification(),
    post_impact: sealedImpact({ phase: "post" }),
    implementer_handoff: goodImplementerHandoff({
      run_id: "eval-tdd",
      unit_or_task: "u1",
      base_commit: "base",
      commit: "c1",
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /TDD/i.test(e)));
});

test("DAG treats glob overlap as file conflict", async () => {
  const { buildTaskDag, readyTasks } = await import("../../scripts/lib/task-dag.js");
  const dag = buildTaskDag([
    { id: "a", files: ["src/*"] },
    { id: "b", files: ["src/foo.js"] },
  ]);
  const ready = readyTasks(dag, {
    completed: new Set(),
    running: [{ id: "a", files: ["src/*"] }],
  });
  assert.equal(ready.some((t) => t.id === "b"), false);
});

test("pre-impact without diff does not claim high trust", async () => {
  const { computeConfidence } = await import("../../scripts/lib/impact/confidence.js");
  const c = computeConfidence({ hasDiff: false, preImpact: true, gitOk: true });
  assert.ok(c < 0.75);
});
