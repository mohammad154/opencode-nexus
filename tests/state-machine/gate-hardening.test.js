/**
 * V5 gate hardening — fixed pipeline invariants.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyRunState } from "../../scripts/lib/migrate-artifacts.js";
import {
  canTransition,
  transition,
} from "../../scripts/lib/state-machine.js";
import { assertValidRunId } from "../../scripts/lib/policy.js";
import { normalizeHandoff } from "../../scripts/lib/migrate-artifacts.js";
import {
  goodImplementerHandoff,
  goodReviewerHandoff,
  goodReviewPackage,
  finalReviewingState,
  finalVerifyingEvidence,
  mockTrustProviders,
  sealedImpact,
} from "../helpers/gate-fixtures.js";

function driftOk(head = "base111") {
  return {
    schema_version: "1.0",
    plan_commit: head,
    current_head: head,
    drift: "NONE",
    reasons: [],
  };
}

const temporaryPlanRoots = [];

after(() => {
  for (const root of temporaryPlanRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function planWorktree() {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gate-plan-"));
  temporaryPlanRoots.push(worktree);
  const planDir = path.join(worktree, ".opencode", "plans");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(
    path.join(planDir, "PLAN.md"),
    [
      "# Plan",
      "- Planning mode: compact",
      "- Plan commit: 1234567",
      "",
      "## Goal",
      "Deliver the behavior.",
      "",
      "## Non-goals",
      "- No unrelated refactoring.",
      "",
      "## Execution Unit Justification",
      "Number of units: 1",
      "",
      "Why not fewer:",
      "- One cohesive behavior owns the outcome.",
      "",
      "Why not more:",
      "- There is no independent boundary to split.",
      "",
      "## Execution Unit breakdown",
      "### Execution Unit 1: behavior",
      "- id: unit-1",
      "- user_outcome: Deliver the behavior",
      "- independently_shippable: true",
      "- review_boundary: NONE",
      "- estimated_lines: 10",
      "- Allowed files: `src/app.js`",
      "- Evidence:",
      "  - `src/app.js:1` – current behavior",
      "- Acceptance criteria:",
      "  - [ ] behavior works.",
      "- Verification gates:",
      "  1. npm test",
      "- STOP conditions:",
      "  - STOP if `src/app.js` no longer exists.",
      "",
    ].join("\n"),
  );
  return worktree;
}

function toPlanned(runId = "gate") {
  let s = createEmptyRunState(runId);
  s = transition(s, "BRAINSTORMING", {}).state;
  const planned = transition(s, "PLANNED", {
    plan_exists: true,
    plan_check: { ok: true, plan_check: "PASS", errors: [] },
    worktree: planWorktree(),
  });
  assert.equal(planned.ok, true, JSON.stringify(planned.errors));
  return planned.state;
}

test("assertValidRunId rejects path separators", () => {
  assert.throws(() => assertValidRunId("../x"));
  assert.equal(assertValidRunId("ok-run_1"), "ok-run_1");
});

test("IMPLEMENTING without drift is rejected", () => {
  const providers = mockTrustProviders({
    impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
  });
  let state = toPlanned("g-drift");
  state = transition(
    state,
    "TASK_IMPACT_READY",
    {
      planned_targets: ["src/app.js"],
      impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
    },
    providers,
  ).state;
  const r = canTransition(state, "IMPLEMENTING", {
    branch: "feat/x",
    acceptance_criteria: ["a"],
    allowed_files: ["src/app.js"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /drift/i.test(e)));
});

test("pre-impact can enter TASK_IMPACT_READY without trusted label", () => {
  const providers = mockTrustProviders({
    impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
  });
  let state = toPlanned("g-pre");
  const r = transition(
    state,
    "TASK_IMPACT_READY",
    {
      planned_targets: ["src/app.js"],
      impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
    },
    providers,
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.require_post_impact, true);
});

test("REVIEWING → COMPLETED is illegal (must FINAL_VERIFYING)", () => {
  const state = {
    ...createEmptyRunState("g-complete"),
    state: "REVIEWING",
    implementer_commit: "impl222",
  };
  const r = canTransition(state, "COMPLETED", {
    review_handoff: goodReviewerHandoff({ run_id: "g-complete" }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /illegal transition/i.test(e)));
});

test("multi-task FINAL_VERIFYING does not require integration-reviewer", () => {
  const state = finalReviewingState({
    ...createEmptyRunState("g-multi"),
    implementer_commit: "impl222",
    current_unit: "unit-1",
    tasks: ["a", "b"],
  });
  const r = canTransition(
    state,
    "FINAL_VERIFYING",
    finalVerifyingEvidence({ run_id: "g-multi" }),
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("normalizeHandoff remaps legacy unified-reviewer agent to reviewer", () => {
  const { data } = normalizeHandoff("unified-reviewer", {
    schema_version: "1.1",
    run_id: "x",
    unit_or_task: "u",
    agent: "unified-reviewer",
    base_commit: null,
    created_at: "2026-01-01T00:00:00.000Z",
    verdict: "APPROVED",
    reviewed_commit: "c",
  });
  assert.equal(data.agent, "reviewer");
  assert.equal(data.schema_version, "1.2");
});

test("IMPLEMENTING → VERIFYING is a fast handoff gate and never calls providers", () => {
  const state = {
    ...createEmptyRunState("g-ver"),
    state: "IMPLEMENTING",
    head_commit: "base111",
    current_unit: "unit-1",
    allowed_files: ["src/app.js"],
    require_post_impact: true,
  };
  let calls = 0;
  const providers = {
    impactProvider: {
      analyze() {
        calls += 1;
        throw new Error("post-impact must not run during transition");
      },
    },
    verificationProvider: {
      discover() {
        calls += 1;
        throw new Error("discover must not run during transition");
      },
      run() {
        calls += 1;
        throw new Error("verification must not run during transition");
      },
    },
    telemetry: { emit() {} },
  };
  const r = transition(
    state,
    "VERIFYING",
    { implementer_handoff: goodImplementerHandoff({ run_id: "g-ver" }) },
    providers,
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.state, "VERIFYING");
  assert.equal(r.state.verification_status, "PENDING");
  assert.equal(calls, 0);
});

test("force_reimpact cannot bypass missing review_handoff on REVIEWING→TASK_IMPACT_READY", () => {
  let state = createEmptyRunState("g-force");
  state.state = "REVIEWING";
  state.implementer_commit = "impl222";
  state.current_unit = "unit-1";
  const r = canTransition(state, "TASK_IMPACT_READY", {
    force_reimpact: true,
    impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /review_handoff/i.test(e)));
});

test("fabricated trusted impact rejected at TASK_IMPACT_READY without provider", () => {
  let state = toPlanned("g-fab");
  const r = canTransition(state, "TASK_IMPACT_READY", {
    impact: {
      risk: "LOW",
      trusted: true,
      fabricated: true,
      planned_targets: ["src/app.js"],
    },
  });
  assert.equal(r.ok, false);
});
