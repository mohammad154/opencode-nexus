/**
 * Hardening: run_base_commit, package bind/digest, AC persistence, file coverage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildReviewPackage,
  assertReviewPackageBound,
  resolveReviewPackageBase,
} from "../scripts/lib/review-package.js";
import {
  isApprovalAdmissible,
  expectedAcceptanceCriteria,
} from "../scripts/lib/review-protocol.js";
import { transition, canTransition } from "../scripts/lib/state-machine.js";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import {
  goodReviewerHandoff,
  goodReviewPackage,
  mockTrustProviders,
  sealedImpact,
} from "./helpers/gate-fixtures.js";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${args.join(" ")}\n${r.stderr}`);
  return r.stdout.trim();
}

function multiCommitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-multi-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "t@ex.com"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "t1.js"), "export const t1 = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(dir, "t1.js"), "export const t1 = 2;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "task1"]);
  const task1 = git(dir, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(dir, "t2.js"), "export const t2 = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "task2"]);
  const task2 = git(dir, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(dir, "t3.js"), "export const t3 = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "task3"]);
  const task3 = git(dir, ["rev-parse", "HEAD"]);
  return { dir, base, task1, task2, task3 };
}

test("resolveReviewPackageBase: final uses run_base_commit, task uses head_commit", () => {
  const state = {
    run_base_commit: "RUNBASE",
    head_commit: "TASKHEAD",
    plan_commit: "PLAN",
  };
  assert.equal(resolveReviewPackageBase(state, "final"), "RUNBASE");
  assert.equal(resolveReviewPackageBase(state, "task"), "TASKHEAD");
});

test("final review package diffs RUN_BASE..HEAD across three tasks", () => {
  const { dir, base, task2, task3 } = multiCommitRepo();
  const meta = buildReviewPackage(dir, {
    scope: "final",
    runState: {
      run_id: "multi",
      current_unit: "task-3",
      run_base_commit: base,
      head_commit: task2, // last pre-task head — must NOT be used for final
      implementer_commit: task3,
    },
    baseCommit: undefined,
    headCommit: task3,
  });
  assert.equal(meta.base_commit, base);
  assert.equal(meta.head_commit, task3);
  assert.ok(meta.changed_files.includes("t1.js"));
  assert.ok(meta.changed_files.includes("t2.js"));
  assert.ok(meta.changed_files.includes("t3.js"));
  const md = fs.readFileSync(path.join(dir, meta.path), "utf8");
  assert.match(md, /t1 = 2/);
  assert.match(md, /export const t2/);
  assert.match(md, /export const t3/);
  // Task-scoped package from task3 pre-head should NOT include t1/t2 if base is task2
  const taskPkg = buildReviewPackage(dir, {
    scope: "task",
    runState: {
      run_id: "multi",
      current_unit: "task-3",
      run_base_commit: base,
      head_commit: task2,
      implementer_commit: task3,
    },
    headCommit: task3,
  });
  assert.equal(taskPkg.base_commit, task2);
  assert.deepEqual(taskPkg.changed_files, ["t3.js"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("IMPLEMENTING freezes run_base_commit and persists acceptance_criteria", () => {
  const providers = mockTrustProviders({
    impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
  });
  let state = createEmptyRunState("ac-persist");
  state = transition(state, "BRAINSTORMING", {}).state;
  fs.mkdirSync(path.join(os.tmpdir(), "nexus-plan-x"), { recursive: true });
  // Use transition path without real plan file via admin skip not available —
  // set PLANNED via direct state then TASK_IMPACT_READY
  state.state = "PLANNED";
  state = transition(
    state,
    "TASK_IMPACT_READY",
    {
      planned_targets: ["src/app.js"],
      impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
    },
    providers,
  ).state;
  const r = transition(
    state,
    "IMPLEMENTING",
    {
      branch: "feat/x",
      acceptance_criteria: ["c1", "c2", "c3"],
      allowed_files: ["src/app.js"],
      drift: {
        schema_version: "1.0",
        plan_commit: "base111",
        current_head: "base111",
        drift: "NONE",
        reasons: [],
      },
      current_unit: "u1",
    },
    providers,
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.run_base_commit, "base111");
  assert.deepEqual(r.state.acceptance_criteria, ["c1", "c2", "c3"]);
  // Second implement must not overwrite run_base_commit
  r.state.state = "TASK_IMPACT_READY";
  r.state.impact_consumed_for_implement = false;
  const r2 = transition(
    r.state,
    "IMPLEMENTING",
    {
      branch: "feat/x",
      acceptance_criteria: ["later"],
      allowed_files: ["src/app.js"],
      drift: {
        schema_version: "1.0",
        plan_commit: "base111",
        current_head: "task2head",
        drift: "NONE",
        reasons: [],
      },
      impact: sealedImpact({ phase: "pre", pre_impact: true, trusted: false }),
      current_unit: "u2",
    },
    providers,
  );
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  assert.equal(r2.state.run_base_commit, "base111");
  assert.equal(r2.state.head_commit, "task2head");
  assert.deepEqual(r2.state.acceptance_criteria, ["later"]);
});

test("isApprovalAdmissible requires all persisted acceptance criteria", () => {
  const handoff = goodReviewerHandoff({
    acceptance: [
      {
        id: "AC-1",
        status: "PASS",
        evidence: [{ file: "src/app.js", line: 1, reason: "c1 ok" }],
      },
    ],
  });
  const r = isApprovalAdmissible(handoff, {
    acceptance_criteria: ["c1", "c2", "c3", "c4", "c5"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /at least 5|AC-2|coverage/i.test(e)));
});

test("isApprovalAdmissible requires files_reviewed cover production_files", () => {
  const handoff = goodReviewerHandoff({
    files_reviewed: ["src/a.js"],
  });
  const r = isApprovalAdmissible(
    handoff,
    {},
    {
      review_package: {
        production_files: ["src/a.js", "src/b.js"],
        changed_files: ["src/a.js", "src/b.js"],
      },
    },
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /src\/b\.js/.test(e)));

  const ok = isApprovalAdmissible(
    {
      ...handoff,
      files_reviewed: ["src/a.js"],
      files_skipped: [{ file: "src/b.js", reason: "generated vendor stub" }],
    },
    {},
    {
      review_package: {
        production_files: ["src/a.js", "src/b.js"],
      },
    },
  );
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test("assertReviewPackageBound verifies digest and reviewed_commit binding", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-bind-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "t@ex.com"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "b"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 2;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "h"]);
  const head = git(dir, ["rev-parse", "HEAD"]);

  const meta = buildReviewPackage(dir, {
    scope: "task",
    runState: {
      run_id: "bind",
      current_unit: "u1",
      head_commit: base,
      implementer_commit: head,
      run_base_commit: base,
    },
    headCommit: head,
  });
  const ok = assertReviewPackageBound(meta, {
    scope: "task",
    worktree: dir,
    state: {
      run_id: "bind",
      current_unit: "u1",
      implementer_commit: head,
      run_base_commit: base,
    },
    handoff: { reviewed_commit: head },
    requireDigest: true,
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));

  const stale = assertReviewPackageBound(
    { ...meta, head_commit: base },
    {
      scope: "task",
      worktree: dir,
      state: { run_id: "bind", current_unit: "u1", implementer_commit: head },
      handoff: { reviewed_commit: head },
    },
  );
  assert.equal(stale.ok, false);

  const tampered = { ...meta, digest_sha256: "deadbeef" };
  const badDigest = assertReviewPackageBound(tampered, {
    scope: "task",
    worktree: dir,
    state: { run_id: "bind", current_unit: "u1", implementer_commit: head },
    handoff: { reviewed_commit: head },
  });
  assert.equal(badDigest.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("FINAL_VERIFYING requires final package base == run_base_commit", () => {
  const state = {
    ...createEmptyRunState("rb"),
    state: "FINAL_REVIEWING",
    implementer_commit: "impl222",
    run_base_commit: "RUNBASE",
    last_task_review_handoff: goodReviewerHandoff({
      run_id: "rb",
      review_scope: "task",
    }),
    acceptance_criteria: ["done"],
  };
  const r = canTransition(state, "FINAL_VERIFYING", {
    review_handoff: goodReviewerHandoff({
      run_id: "rb",
      review_scope: "final",
    }),
    review_package: goodReviewPackage({
      scope: "final",
      base_commit: "WRONG",
      head_commit: "impl222",
      run_id: "rb",
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /run_base_commit/i.test(e)));
});

test("expectedAcceptanceCriteria aggregates task_history for final", () => {
  const list = expectedAcceptanceCriteria(
    {
      task_history: [
        { acceptance_criteria: ["a", "b"] },
        { acceptance_criteria: ["c"] },
      ],
    },
    { review_scope: "final" },
  );
  assert.deepEqual(list, ["a", "b", "c"]);
});
