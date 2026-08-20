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
