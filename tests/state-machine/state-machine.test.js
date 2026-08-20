import test from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyRunState,
  writeRunState,
  readRunState,
} from "../../scripts/lib/migrate-artifacts.js";
import {
  canTransition,
  transition,
  STATES,
  requiredEvidence,
} from "../../scripts/lib/state-machine.js";
import {
  goodImplementerHandoff,
  goodReviewerHandoff,
  mockTrustProviders,
  sealedImpact,
  sealedVerification,
} from "../helpers/gate-fixtures.js";
import fs from "fs";
import os from "os";
import path from "path";

function driftOk(head = "base111") {
  return {
    schema_version: "1.0",
    plan_commit: head,
    current_head: head,
    drift: "NONE",
    reasons: [],
    commits_ahead: 0,
    ok: true,
  };
}

function writePlan(worktree) {
  const dir = path.join(worktree, ".opencode", "plans");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "PLAN.md");
  fs.writeFileSync(p, "# Plan\n\n## Goal\ntest\n");
  return p;
}

function advanceToPlanned(state, worktree = null) {
  let s = transition(state, "BRAINSTORMING", {}).state;
  const plan_path = worktree ? writePlan(worktree) : null;
  s = transition(s, "PLANNED", {
    plan_exists: true,
    ...(plan_path ? { plan_path, worktree } : {}),
  }).state;
  return s;
}

function advanceToImpactReady(state, providers = mockTrustProviders()) {
  let s = advanceToPlanned(state);
  const r = transition(
    s,
    "TASK_IMPACT_READY",
    {
      planned_targets: ["src/app.js"],
      impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
    },
    providers,
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.state;
}

test("illegal transition CREATED → IMPLEMENTING rejected", () => {
  const state = createEmptyRunState("t1");
  const r = canTransition(state, "IMPLEMENTING", {});
  assert.equal(r.ok, false);
});

test("CREATED → BRAINSTORMING → PLANNED without classify requires PLAN.md", () => {
  let state = createEmptyRunState("t2");
  let r = transition(state, "BRAINSTORMING", {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  r = transition(r.state, "PLANNED", {});
  assert.equal(r.ok, false);
  r = transition(r.state || state, "PLANNED", { plan_exists: true });
  // state may still be BRAINSTORMING from failed transition
  state = transition(createEmptyRunState("t2b"), "BRAINSTORMING", {}).state;
  r = transition(state, "PLANNED", { plan_exists: true });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.state, "PLANNED");
});

test("plan_skip rejected without admin compatibility mode", () => {
  let state = transition(createEmptyRunState("t2c"), "BRAINSTORMING", {}).state;
  const r = transition(state, "PLANNED", { plan_skip: true });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /PLAN\.md/);
});

test("WAITING_FOR_USER requires a question then returns to BRAINSTORMING", () => {
  let state = createEmptyRunState("t-wait");
  state = transition(state, "BRAINSTORMING", {}).state;
  let r = canTransition(state, "WAITING_FOR_USER", {});
  assert.equal(r.ok, false);
  r = transition(state, "WAITING_FOR_USER", {
    question: "JWT or session auth?",
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  r = transition(r.state, "BRAINSTORMING", {});
  assert.equal(r.ok, true);
});

test("IMPLEMENTING rejected without fresh sealed pre-impact path", () => {
  let state = createEmptyRunState("t3");
  state = advanceToPlanned(state);
  const r = canTransition(state, "IMPLEMENTING", {
    branch: "feat/x",
    acceptance_criteria: ["done"],
    drift: driftOk(),
  });
  assert.equal(r.ok, false);
});

test("TASK_IMPACT_READY → IMPLEMENTING with impact + drift", () => {
  const providers = mockTrustProviders({
    impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
  });
  let state = createEmptyRunState("t4");
  state = advanceToImpactReady(state, providers);
  const r = transition(
    state,
    "IMPLEMENTING",
    {
      branch: "feat/x",
      acceptance_criteria: ["done"],
      drift: driftOk(),
      allowed_files: ["src/app.js"],
      current_unit: "unit-1",
    },
    providers,
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.state, "IMPLEMENTING");
  assert.equal(r.state.impact_consumed_for_implement, true);
});

test("DIRECT_IMPLEMENTING and CLASSIFIED are unknown/illegal", () => {
  const state = createEmptyRunState("t5");
  assert.equal(STATES.includes("CLASSIFIED"), false);
  assert.equal(STATES.includes("DIRECT_IMPLEMENTING"), false);
  assert.equal(canTransition(state, "CLASSIFIED", {}).ok, false);
});

test("corrupt handoff blocks VERIFYING", () => {
  let state = createEmptyRunState("t6");
  state = advanceToImpactReady(state);
  state.state = "IMPLEMENTING";
  state.head_commit = "base111";
  const r = canTransition(state, "VERIFYING", {
    implementer_handoff: { schema_version: "1.0", status: "NOPE" },
  });
  assert.equal(r.ok, false);
});

test("REVIEWING REQUEST_CHANGES → TASK_IMPACT_READY requires fresh impact", () => {
  const providers = mockTrustProviders({
    impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
  });
  let state = createEmptyRunState("t7");
  state = advanceToImpactReady(state, providers);
  state = transition(
    state,
    "IMPLEMENTING",
    {
      branch: "feat/x",
      acceptance_criteria: ["a"],
      drift: driftOk(),
      allowed_files: ["src/app.js"],
      current_unit: "unit-1",
    },
    providers,
  ).state;
  state.head_commit = "base111";
  state.implementer_commit = "impl222";
  state.provider_verification = sealedVerification();
  state.state = "REVIEWING";

  const requestChanges = goodReviewerHandoff({
    verdict: "REQUEST_CHANGES",
    findings: [
      {
        id: "f1",
        severity: "HIGH",
        file: "src/app.js",
        line: 10,
        message: "bug",
      },
    ],
  });

  let r = canTransition(state, "TASK_IMPACT_READY", {
    review_handoff: requestChanges,
  });
  assert.equal(r.ok, false, "must require fresh impact");

  r = transition(
    state,
    "TASK_IMPACT_READY",
    {
      review_handoff: requestChanges,
      planned_targets: ["src/app.js"],
      impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
    },
    providers,
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.state, "TASK_IMPACT_READY");
  assert.equal(r.state.impact_consumed_for_implement, false);
  assert.equal(r.state.pending_review_findings.length, 1);
});

test("APPROVED → FINAL_VERIFYING with reviewer handoff", () => {
  let state = createEmptyRunState("t8");
  state.state = "REVIEWING";
  state.implementer_commit = "impl222";
  state.current_unit = "unit-1";
  state.head_commit = "base111";
  const review = goodReviewerHandoff({ run_id: "t8" });
  const r = canTransition(state, "FINAL_VERIFYING", {
    review_handoff: review,
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("no self-approval: reviewer agent must not match implementer", () => {
  let state = createEmptyRunState("t9");
  state.state = "REVIEWING";
  state.implementer_commit = "impl222";
  state.last_implementer_handoff = { agent: "reviewer" };
  const review = goodReviewerHandoff();
  const r = canTransition(state, "FINAL_VERIFYING", {
    review_handoff: review,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /self-approval/i);
});

test("IMPACT_READY alias maps to TASK_IMPACT_READY", () => {
  assert.deepEqual(requiredEvidence("PLANNED", "TASK_IMPACT_READY"), [
    "impact",
  ]);
  const providers = mockTrustProviders({
    impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
  });
  let state = advanceToPlanned(createEmptyRunState("t10"));
  const r = transition(
    state,
    "IMPACT_READY",
    {
      planned_targets: ["src/app.js"],
      impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
    },
    providers,
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.state, "TASK_IMPACT_READY");
});

test("run state round-trip persists workflow default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-v5-"));
  fs.mkdirSync(path.join(dir, ".opencode", "runs", "r1"), { recursive: true });
  const state = createEmptyRunState("r1");
  writeRunState(dir, state);
  const loaded = readRunState(dir, "r1");
  assert.equal(loaded.workflow, "default");
  assert.equal(loaded.state, "CREATED");
});

test("V5 STATES enum", () => {
  assert.deepEqual(
    STATES.filter((s) => !["BLOCKED", "FAILED"].includes(s)),
    [
      "CREATED",
      "BRAINSTORMING",
      "WAITING_FOR_USER",
      "PLANNED",
      "TASK_IMPACT_READY",
      "IMPLEMENTING",
      "VERIFYING",
      "REVIEWING",
      "FINAL_VERIFYING",
      "COMPLETED",
    ],
  );
});
