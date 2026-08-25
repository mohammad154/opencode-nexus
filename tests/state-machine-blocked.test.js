import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import { transition, canTransition } from "../scripts/lib/state-machine.js";
import {
  goodImplementerHandoff,
  goodUnifiedHandoff,
  goodReviewPackage,
  sealedVerification,
  mockTrustProviders,
  sealedImpact,
  verifyingEvidence,
} from "./helpers/gate-fixtures.js";

test("BLOCKED preserves blocked_from and resume_state", () => {
  const state = { ...createEmptyRunState("r1"), state: "VERIFYING" };
  const r = transition(state, "BLOCKED", {
    code: "SCOPE_EXPANSION_REQUIRED",
    reason: "out of scope",
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.blocked_from, "VERIFYING");
  assert.strictEqual(r.state.resume_state, "VERIFYING");
  assert.strictEqual(r.state.block_code, "SCOPE_EXPANSION_REQUIRED");
});

test("BLOCKED cannot transition directly to REVIEWING without resume gate satisfaction", () => {
  const state = {
    ...createEmptyRunState("r1"),
    state: "BLOCKED",
    blocked_from: "VERIFYING",
    resume_state: "VERIFYING",
    block_code: "SCOPE_EXPANSION_REQUIRED",
  };
  const r = transition(state, "REVIEWING", { resume_to: "REVIEWING" });
  assert.strictEqual(r.ok, false);
});

test("BLOCKED ignores caller-forged resume_state (locked to blocked_from)", () => {
  const state = { ...createEmptyRunState("r1"), state: "VERIFYING" };
  const r = transition(state, "BLOCKED", {
    code: "SCOPE_EXPANSION_REQUIRED",
    reason: "needs re-planning",
    resume_state: "PLANNED",
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.blocked_from, "VERIFYING");
  assert.strictEqual(r.state.resume_state, "VERIFYING");
  assert.strictEqual(r.state.block_reason, "needs re-planning");
});

test("BLOCKED cannot resume to PLANNED when blocked_from is VERIFYING", () => {
  const state = {
    ...createEmptyRunState("r1"),
    state: "BLOCKED",
    blocked_from: "VERIFYING",
    resume_state: "VERIFYING",
    block_code: "REPLAN_NEEDED",
  };
  const fail = transition(state, "PLANNED", { plan_exists: true });
  assert.strictEqual(fail.ok, false);
  assert.ok(fail.errors.some((e) => /illegal transition/i.test(e)));

  const resume = transition(state, "VERIFYING", {
    ...verifyingEvidence(),
    implementer_handoff: goodImplementerHandoff({ run_id: "r1" }),
  });
  // May fail on other gates; must not be illegal-transition to VERIFYING
  assert.ok(
    resume.ok || !resume.errors.some((e) => /illegal transition/i.test(e)),
    JSON.stringify(resume.errors),
  );
});

test("BLOCKED rejects transition to arbitrary states that do not match blocked_from", () => {
  const state = {
    ...createEmptyRunState("r1"),
    state: "BLOCKED",
    blocked_from: "IMPLEMENTING",
    resume_state: "IMPLEMENTING",
    block_code: "SCOPE_EXPANSION_REQUIRED",
  };
  const r1 = transition(state, "COMPLETED", {});
  assert.strictEqual(r1.ok, false);
  const r2 = transition(state, "FINAL_VERIFYING", {});
  assert.strictEqual(r2.ok, false);
  const r3 = transition(state, "REVIEWING", {});
  assert.strictEqual(r3.ok, false);
});

test("BLOCKED can transition to FAILED with reason", () => {
  const state = {
    ...createEmptyRunState("r1"),
    state: "BLOCKED",
    blocked_from: "IMPLEMENTING",
    resume_state: "IMPLEMENTING",
    block_code: "FATAL_ERROR",
  };
  const r = transition(state, "FAILED", { reason: "unresolvable failure" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.state, "FAILED");
});

test("BLOCKED resuming to REVIEWING fails if provider_verification is missing or unsealed", () => {
  const state = {
    ...createEmptyRunState("r1"),
    state: "BLOCKED",
    blocked_from: "REVIEWING",
    resume_state: "REVIEWING",
    block_code: "MANUAL_CHECK",
  };
  const r = transition(state, "REVIEWING", {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /provider_verification/i.test(e)));
});

test("BLOCKED resuming to REVIEWING succeeds when provider_verification is sealed and ok", () => {
  const state = {
    ...createEmptyRunState("r1"),
    state: "BLOCKED",
    blocked_from: "REVIEWING",
    resume_state: "REVIEWING",
    block_code: "MANUAL_CHECK",
    provider_verification: sealedVerification({ ok: true }),
  };
  const r = transition(state, "REVIEWING", {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.state, "REVIEWING");
});

test("BLOCKED resuming to FINAL_VERIFYING fails without approved review handoff", () => {
  const state = {
    ...createEmptyRunState("r1"),
    state: "BLOCKED",
    blocked_from: "FINAL_VERIFYING",
    resume_state: "FINAL_VERIFYING",
    block_code: "REVIEW_ISSUE",
  };
  const r = transition(state, "FINAL_VERIFYING", {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /APPROVED|FINAL_VERIFYING/i.test(e)));
});

test("BLOCKED resuming to FINAL_VERIFYING succeeds with valid approved review handoff", () => {
  const state = {
    ...createEmptyRunState("r1"),
    state: "BLOCKED",
    blocked_from: "FINAL_VERIFYING",
    resume_state: "FINAL_VERIFYING",
    block_code: "REVIEW_ISSUE",
    implementer_commit: "impl222",
    last_review_handoff: goodUnifiedHandoff({
      run_id: "r1",
      verdict: "APPROVED",
      review_scope: "final",
    }),
    review_package: goodReviewPackage({ scope: "final" }),
  };
  const r = transition(state, "FINAL_VERIFYING", {});
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.state.state, "FINAL_VERIFYING");
});

test("BLOCKED resuming to VERIFYING enforces implementer handoff and verification gates", () => {
  const state = {
    ...createEmptyRunState("r1"),
    state: "BLOCKED",
    blocked_from: "VERIFYING",
    resume_state: "VERIFYING",
    block_code: "TEST_FLAKE",
  };
  const r = transition(state, "VERIFYING", {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /implementer handoff/i.test(e)));
});

test("BLOCKED transition requires reason and classification code", () => {
  const state = { ...createEmptyRunState("r1"), state: "IMPLEMENTING" };
  const r1 = transition(state, "BLOCKED", { reason: "some reason" });
  assert.strictEqual(r1.ok, false);
  assert.ok(r1.errors.some((e) => /code/i.test(e)));

  const r2 = transition(state, "BLOCKED", { code: "SOME_CODE" });
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.errors.some((e) => /reason/i.test(e)));
});

test("BLOCKED cannot transition directly to COMPLETED even if review_level is none", () => {
  const state = {
    ...createEmptyRunState("r1"),
    state: "BLOCKED",
    blocked_from: "VERIFYING",
    resume_state: "VERIFYING",
    review_level: "none",
    block_code: "PAUSED",
  };
  const r = transition(state, "COMPLETED", {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /illegal transition/i.test(e)));
});

test("BLOCKED ignores stale forged resume_state field; only blocked_from is allowed", () => {
  const state = {
    ...createEmptyRunState("r1"),
    state: "BLOCKED",
    blocked_from: "VERIFYING",
    // Stale/forged field from older runs — must not authorize PLANNED
    resume_state: "PLANNED",
    block_code: "REPLAN_NEEDED",
  };
  const forged = transition(state, "PLANNED", { plan_exists: true });
  assert.strictEqual(forged.ok, false);
  assert.ok(forged.errors.some((e) => /illegal transition/i.test(e)));
});

test("BLOCKED re-blocking preserves blocked_from and updates reason/code", () => {
  const initial = {
    ...createEmptyRunState("r1"),
    state: "BLOCKED",
    blocked_from: "IMPLEMENTING",
    resume_state: "IMPLEMENTING",
    block_code: "FIRST_CODE",
    block_reason: "first reason",
  };
  const r = transition(initial, "BLOCKED", {
    code: "UPDATED_CODE",
    reason: "updated reason",
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.blocked_from, "IMPLEMENTING");
  assert.strictEqual(r.state.resume_state, "IMPLEMENTING");
  assert.strictEqual(r.state.block_code, "UPDATED_CODE");
  assert.strictEqual(r.state.block_reason, "updated reason");
});

test("BLOCKED resuming to REVIEWING rejects unsealed caller-supplied provider_verification", () => {
  const state = {
    ...createEmptyRunState("r1"),
    state: "BLOCKED",
    blocked_from: "REVIEWING",
    resume_state: "REVIEWING",
    block_code: "CHECK_REQUIRED",
  };
  const r = transition(state, "REVIEWING", {
    provider_verification: { ok: true, unsealed: true },
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /provider-sealed/i.test(e)));
});
