/**
 * PR7: automation may consume agent output only for the current authorization.
 *
 * Permanent regressions:
 * - A handoff left over from a previous fix-loop attempt can never let advance
 *   skip the agent (the classic "stale evidence becomes trusted" bypass).
 * - An already-consumed handoff cannot be replayed into a second gate.
 * - A reviewer verdict is bound to the commit it reviewed and to the scope the
 *   current state requires.
 * - The next-action resolver distinguishes "waiting for the implementer" from
 *   "the implementer already answered", without weakening the binding guard.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  consumableImplementerHandoff,
  consumableReviewerHandoff,
  enteredStateAt,
  handoffPath,
  isImplementerDone,
} from "../scripts/lib/handoff-freshness.js";
import { resolveNextAction } from "../scripts/lib/next-action.js";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function worktree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pr7-handoff-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".opencode", "handoffs"), { recursive: true });
  return root;
}

function gitRepo() {
  const root = worktree();
  const git = (...args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout?.trim();
  git("init");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(root, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-m", "one");
  const first = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "a.txt"), "two\n");
  git("add", ".");
  git("commit", "-m", "two");
  const second = git("rev-parse", "HEAD");
  return { root, first, second };
}

function write(root, runId, role, data) {
  fs.writeFileSync(
    path.join(root, handoffPath(runId, role)),
    JSON.stringify(data, null, 2),
  );
}

const IMPLEMENTING_AT = "2026-09-01T10:00:00.000Z";

function implementingState(overrides = {}) {
  return {
    run_id: "pr7",
    state: "IMPLEMENTING",
    head_commit: "base111",
    current_unit: "unit-1",
    transitions: [
      { from: "TASK_IMPACT_READY", to: "IMPLEMENTING", at: "2026-08-01T00:00:00.000Z" },
      { from: "REVIEWING", to: "TASK_IMPACT_READY", at: "2026-09-01T09:00:00.000Z" },
      { from: "TASK_IMPACT_READY", to: "IMPLEMENTING", at: IMPLEMENTING_AT },
    ],
    ...overrides,
  };
}

function doneHandoff(overrides = {}) {
  return {
    schema_version: "1.1",
    run_id: "pr7",
    unit_or_task: "unit-1",
    agent: "implementer",
    base_commit: "base111",
    created_at: "2026-09-01T10:00:05.000Z",
    status: "DONE",
    commit: "impl222",
    ...overrides,
  };
}

test("state entry timestamps come from the recorded transition log", () => {
  assert.equal(
    enteredStateAt(implementingState()),
    Date.parse(IMPLEMENTING_AT),
    "the most recent entry wins",
  );
  assert.equal(enteredStateAt({ state: "IMPLEMENTING" }), null);
  assert.equal(isImplementerDone({ status: "DONE_WITH_NOTES" }), true);
  assert.equal(isImplementerDone({ status: "BLOCKED" }), false);
});

test("a fresh implementer handoff at current HEAD is consumable", () => {
  const root = worktree();
  write(root, "pr7", "implementer", doneHandoff());
  const verdict = consumableImplementerHandoff(root, implementingState(), "impl222");
  assert.equal(verdict.consumable, true);
  assert.equal(verdict.path, path.join(".opencode", "handoffs", "pr7-implementer.json"));
});

test("a handoff from a previous fix-loop attempt cannot skip the implementer", () => {
  const root = worktree();
  // Attempt 1 produced impl222 from base111. The fix loop re-authorized
  // IMPLEMENTING at impl222, so the old handoff's base is no longer current.
  write(root, "pr7", "implementer", doneHandoff());
  const state = implementingState({ head_commit: "impl222" });
  const verdict = consumableImplementerHandoff(root, state, "impl222");
  assert.equal(verdict.consumable, false);
  assert.equal(verdict.reason, "BASE_NOT_CURRENT_AUTHORIZATION");
});

test("an ancient handoff is rejected even when its commits line up", () => {
  const root = worktree();
  write(root, "pr7", "implementer", doneHandoff({ created_at: "2026-08-01T00:00:01.000Z" }));
  const verdict = consumableImplementerHandoff(root, implementingState(), "impl222");
  assert.equal(verdict.consumable, false);
  assert.equal(verdict.reason, "PREDATES_CURRENT_STATE");
});

test("an already-consumed handoff cannot be replayed", () => {
  const root = worktree();
  const handoff = doneHandoff();
  write(root, "pr7", "implementer", handoff);
  const state = implementingState({ last_implementer_handoff: handoff });
  assert.equal(
    consumableImplementerHandoff(root, state, "impl222").reason,
    "ALREADY_CONSUMED",
  );
});

test("work not present in the tree, other runs, and unfinished work are rejected", () => {
  const root = worktree();
  write(root, "pr7", "implementer", doneHandoff());
  assert.equal(
    consumableImplementerHandoff(root, implementingState(), "somethingelse").reason,
    "COMMIT_NOT_CURRENT_HEAD",
  );

  write(root, "pr7", "implementer", doneHandoff({ run_id: "other-run" }));
  assert.equal(
    consumableImplementerHandoff(root, implementingState(), "impl222").reason,
    "OTHER_RUN",
  );

  write(root, "pr7", "implementer", doneHandoff({ status: "BLOCKED" }));
  assert.equal(
    consumableImplementerHandoff(root, implementingState(), "impl222").reason,
    "NOT_DONE",
  );

  fs.rmSync(path.join(root, handoffPath("pr7", "implementer")));
  assert.equal(consumableImplementerHandoff(root, implementingState(), "impl222").reason, "MISSING");
});

test("an unparsable handoff is absent, never partially trusted", () => {
  const root = worktree();
  fs.writeFileSync(path.join(root, handoffPath("pr7", "implementer")), "{ not json");
  const verdict = consumableImplementerHandoff(root, implementingState(), "impl222");
  assert.equal(verdict.consumable, false);
  assert.equal(verdict.reason, "UNPARSABLE");
  assert.equal(verdict.data, null);
});

test("a reviewer verdict is bound to the reviewed commit and required scope", () => {
  const root = worktree();
  const reviewing = {
    run_id: "pr7",
    state: "REVIEWING",
    transitions: [{ from: "VERIFYING", to: "REVIEWING", at: "2026-09-01T11:00:00.000Z" }],
  };
  const approval = {
    schema_version: "1.2",
    run_id: "pr7",
    agent: "reviewer",
    created_at: "2026-09-01T11:00:09.000Z",
    verdict: "APPROVED",
    review_scope: "task",
    reviewed_commit: "impl222",
  };
  write(root, "pr7", "reviewer", approval);
  assert.equal(consumableReviewerHandoff(root, reviewing, "impl222", "task").consumable, true);

  // After a fix loop the tree moved: the old verdict is not about this code.
  assert.equal(
    consumableReviewerHandoff(root, reviewing, "impl333", "task").reason,
    "REVIEWED_COMMIT_NOT_CURRENT_HEAD",
  );
  // A task review can never stand in for the final integration review.
  assert.equal(
    consumableReviewerHandoff(root, reviewing, "impl222", "final").reason,
    "SCOPE_MISMATCH",
  );
  assert.equal(
    consumableReviewerHandoff(
      root,
      { ...reviewing, last_review_handoff: approval },
      "impl222",
      "task",
    ).reason,
    "ALREADY_CONSUMED",
  );

  write(root, "pr7", "reviewer", { ...approval, verdict: undefined });
  assert.equal(consumableReviewerHandoff(root, reviewing, "impl222", "task").reason, "NO_VERDICT");
});

test("the resolver reports a consumable handoff instead of re-dispatching", () => {
  const { root, first, second } = gitRepo();
  const state = {
    run_id: "pr7",
    state: "IMPLEMENTING",
    head_commit: first,
    branch: null,
    current_unit: "unit-1",
    transitions: [{ from: "TASK_IMPACT_READY", to: "IMPLEMENTING", at: IMPLEMENTING_AT }],
  };

  // Nothing written yet: the implementer is still owed a dispatch, and the moved
  // HEAD is an unexplained binding mismatch.
  const waiting = resolveNextAction(state, { worktree: root });
  assert.equal(waiting.action, "reconcile");

  write(root, "pr7", "implementer", doneHandoff({ base_commit: first, commit: second }));
  const answered = resolveNextAction(state, { worktree: root });
  assert.equal(answered.action, "consume_implementer_handoff");
  assert.match(answered.command, /--to VERIFYING --implementer-handoff-file/);
  assert.equal(answered.agent, null);

  // A handoff for a different commit does not explain the movement.
  write(root, "pr7", "implementer", doneHandoff({ base_commit: first, commit: "deadbeef" }));
  assert.equal(resolveNextAction(state, { worktree: root }).action, "reconcile");
});

test("the binding guard still fires for unexplained movement in FINAL_REVIEWING", () => {
  const { root, first } = gitRepo();
  const state = {
    run_id: "pr7",
    state: "FINAL_REVIEWING",
    implementer_commit: first,
    transitions: [{ from: "REVIEWING", to: "FINAL_REVIEWING", at: IMPLEMENTING_AT }],
  };
  // An implementer handoff can never explain movement outside IMPLEMENTING.
  write(root, "pr7", "implementer", doneHandoff({ base_commit: first, commit: "whatever" }));
  assert.equal(resolveNextAction(state, { worktree: root }).action, "reconcile");
});

test("the binding guard still fires for unexplained movement in REVIEWING", () => {
  const { root, first, second } = gitRepo();
  const state = {
    run_id: "pr7",
    state: "REVIEWING",
    implementer_commit: first,
    transitions: [{ from: "VERIFYING", to: "REVIEWING", at: IMPLEMENTING_AT }],
  };
  // A reviewer handoff must never excuse a moved worktree in REVIEWING.
  write(root, "pr7", "reviewer", {
    schema_version: "1.2",
    run_id: "pr7",
    created_at: "2026-09-01T10:00:05.000Z",
    verdict: "APPROVED",
    review_scope: "task",
    reviewed_commit: second,
  });
  assert.equal(resolveNextAction(state, { worktree: root }).action, "reconcile");
});
