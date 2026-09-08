import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import { canTransition, transition } from "../scripts/lib/state-machine.js";
import {
  goodReviewerHandoff,
  goodReviewPackage,
} from "./helpers/gate-fixtures.js";

function singleUnitReviewState(overrides = {}) {
  return {
    ...createEmptyRunState("reuse-run"),
    state: "REVIEWING",
    current_unit: "unit-1",
    execution_units: [{ id: "unit-1" }],
    units: [{ id: "unit-1" }],
    acceptance_criteria: ["done"],
    implementer_commit: "impl222",
    head_commit: "impl222",
    last_implementer_handoff: { agent: "implementer" },
    ...overrides,
  };
}

function reuseEvidence(overrides = {}) {
  const review_handoff = goodReviewerHandoff({
    run_id: "reuse-run",
    unit_or_task: "unit-1",
    review_scope: "task",
    reviewed_commit: "impl222",
  });
  return {
    reuse_final_review: true,
    current_head: "impl222",
    review_handoff,
    review_package: goodReviewPackage({
      run_id: "reuse-run",
      unit_or_task: "unit-1",
      scope: "task",
      head_commit: "impl222",
      digest_sha256: "fixture",
    }),
    ...overrides,
  };
}

function gitFixture() {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-reuse-git-"));
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  execFileSync("git", ["config", "user.email", "nexus@example.invalid"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "Nexus Test"], { cwd: worktree });
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src", "app.js"), "export const ok = true;\n");
  execFileSync("git", ["add", "src/app.js"], { cwd: worktree });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: worktree });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  }).trim();
  const packagePath = path.join(
    worktree,
    ".opencode",
    "reviews",
    "reuse-review-package.md",
  );
  fs.mkdirSync(path.dirname(packagePath), { recursive: true });
  const packageBody = "# Bound task review package\n";
  fs.writeFileSync(packagePath, packageBody);
  return {
    worktree,
    head,
    review_package: goodReviewPackage({
      run_id: "reuse-run",
      unit_or_task: "unit-1",
      path: ".opencode/reviews/reuse-review-package.md",
      head_commit: head,
      digest_sha256: createHash("sha256").update(packageBody).digest("hex"),
    }),
  };
}

test("single-unit final review reuse fails closed without a worktree", () => {
  const state = singleUnitReviewState();
  const evidence = reuseEvidence();
  const check = canTransition(state, "FINAL_VERIFYING", evidence);
  assert.equal(check.ok, false);
  assert.match(check.errors.join(" "), /bound worktree/i);
});

test("single-unit final review reuse requires explicit bound evidence", (t) => {
  const fixture = gitFixture();
  t.after(() => fs.rmSync(fixture.worktree, { recursive: true, force: true }));
  const state = singleUnitReviewState({
    worktree: fixture.worktree,
    implementer_commit: fixture.head,
    head_commit: fixture.head,
  });
  const evidence = reuseEvidence({
    worktree: fixture.worktree,
    current_head: fixture.head,
    review_handoff: goodReviewerHandoff({
      run_id: "reuse-run",
      unit_or_task: "unit-1",
      review_scope: "task",
      reviewed_commit: fixture.head,
    }),
    review_package: fixture.review_package,
  });
  const check = canTransition(state, "FINAL_VERIFYING", evidence);
  assert.equal(check.ok, true, JSON.stringify(check.errors));

  const result = transition(state, "FINAL_VERIFYING", evidence);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.state.final_review_reused, true);
  assert.equal(result.state.agent_calls_used, 1);
});

test("reviewer approval fails closed when bound workspace changes outside .opencode", (t) => {
  const fixture = gitFixture();
  t.after(() => fs.rmSync(fixture.worktree, { recursive: true, force: true }));
  fs.appendFileSync(path.join(fixture.worktree, "src", "app.js"), "export const changed = true;\n");
  const state = singleUnitReviewState({
    worktree: fixture.worktree,
    implementer_commit: fixture.head,
    head_commit: fixture.head,
  });
  const evidence = reuseEvidence({
    worktree: fixture.worktree,
    current_head: fixture.head,
    review_handoff: goodReviewerHandoff({
      run_id: "reuse-run",
      unit_or_task: "unit-1",
      review_scope: "task",
      reviewed_commit: fixture.head,
    }),
    review_package: fixture.review_package,
  });
  const result = canTransition(state, "FINAL_VERIFYING", evidence);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /workspace changed outside \.opencode/i);
});

test("single-unit final review reuse rejects multiple units and stale HEAD", () => {
  const multiple = singleUnitReviewState({
    execution_units: [{ id: "unit-1" }, { id: "unit-2" }],
    units: [{ id: "unit-1" }, { id: "unit-2" }],
  });
  const multiResult = canTransition(multiple, "FINAL_VERIFYING", reuseEvidence());
  assert.equal(multiResult.ok, false);
  assert.match(multiResult.errors.join(" "), /exactly one execution unit/i);

  const stale = canTransition(
    singleUnitReviewState({ implementer_commit: "new-head", head_commit: "new-head" }),
    "FINAL_VERIFYING",
    reuseEvidence(),
  );
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join(" "), /final HEAD|head_commit/i);
});

test("standard planning requires one advisor and rejects an over-budget advisor claim", () => {
  const state = {
    ...createEmptyRunState("planning-run"),
    state: "BRAINSTORMING",
  };
  const missing = canTransition(state, "PLANNED", {
    plan_exists: true,
    planning_mode: "standard",
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(" "), /plan-advisor/i);

  const over = canTransition(state, "PLANNED", {
    plan_exists: true,
    plan_check: { ok: true, plan_check: "PASS", errors: [] },
    planning_mode: "standard",
    plan_advisor_calls: 1,
    plan_advisor: {
      agent: "plan-advisor",
      calls: 2,
      read_only: true,
      model: "openai/gpt-5-mini",
    },
  });
  assert.equal(over.ok, false);
  assert.match(over.errors.join(" "), /permits 1/i);
});

test("standard planning accepts only a schema-complete advisor handoff", () => {
  const state = {
    ...createEmptyRunState("planning-valid-advisor"),
    state: "BRAINSTORMING",
  };
  const result = canTransition(state, "PLANNED", {
    plan_exists: true,
    plan_check: { ok: true, plan_check: "PASS", errors: [] },
    planning_mode: "standard",
    plan_advisor: {
      schema_version: "1.0",
      agent: "plan-advisor",
      calls: 1,
      read_only: true,
      permission_profile: "read-only-bash-allowlist",
      plan_verdict: "KEEP",
      simpler_approach_available: false,
      units: [],
      missing_dependencies: [],
      missing_edge_cases: [],
      risk_misses: [],
      recommended_unit_count: 1,
      model: "openai/gpt-5-mini",
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("planning transition persists the validated advisor call count", () => {
  const state = {
    ...createEmptyRunState("planning-call-count"),
    state: "BRAINSTORMING",
  };
  const advisor = {
    schema_version: "1.0",
    agent: "plan-advisor",
    calls: 2,
    read_only: true,
    permission_profile: "read-only-bash-allowlist",
    plan_verdict: "KEEP",
    simpler_approach_available: false,
    units: [],
    missing_dependencies: [],
    missing_edge_cases: [],
    risk_misses: [],
    recommended_unit_count: 1,
    model: "openai/gpt-5-mini",
  };
  const result = transition(state, "PLANNED", {
    plan_exists: true,
    plan_check: { ok: true, plan_check: "PASS", errors: [] },
    planning_mode: "deep",
    critical_disagreement: true,
    plan_advisor_calls: 1,
    plan_advisor: advisor,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.state.plan_advisor_calls, 2);
  assert.equal(result.state.agent_calls_used, 2);
});

test("standard planning rejects an incomplete advisor handoff", () => {
  const state = {
    ...createEmptyRunState("planning-incomplete-advisor"),
    state: "BRAINSTORMING",
  };
  const result = canTransition(state, "PLANNED", {
    plan_exists: true,
    planning_mode: "standard",
    plan_advisor: {
      calls: 0,
      model: "openai/gpt-5-mini",
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /plan-advisor|read_only/i);
});
