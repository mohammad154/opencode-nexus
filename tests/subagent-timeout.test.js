import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSubagentWatchdog,
  degradeSubagentTimeout,
  readSubagentTimeouts,
  recordSubagentTimeout,
} from "../scripts/lib/subagent-budget.js";
import { resolveNextAction } from "../scripts/lib/next-action.js";
import { resolveMaxReviewRounds } from "../scripts/lib/review-protocol.js";
import { planAdvanceStep } from "../scripts/lib/advance.js";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-timeout-"));
}

test("a fake timer writes TIMED_OUT and does not abort the parent session", () => {
  const root = tempRoot();
  const aborted = [];
  const timers = [];
  const watchdog = createSubagentWatchdog({
    budgets: { "plan-advisor": 50, reviewer: 50, implementer: 50 },
    schedule(fn) {
      timers.push(fn);
      return timers.length;
    },
    cancel() {},
    now: () => 1_000,
    onTimeout(event) {
      recordSubagentTimeout(root, event);
      if (event.childSessionID) aborted.push(event.childSessionID);
    },
  });
  watchdog.noteChildSession("parent", "parent");
  watchdog.before(
    { tool: "task", callID: "call-1", sessionID: "parent" },
    { args: { agent: "plan-advisor" } },
  );
  assert.equal(timers.length, 1);
  timers[0]();
  const saved = readSubagentTimeouts(root);
  assert.equal(saved["plan-advisor"].status, "TIMED_OUT");
  assert.equal(saved["plan-advisor"].attempts, 1);
  assert.deepEqual(aborted, []);
  const handoff = JSON.parse(
    fs.readFileSync(path.join(root, ".opencode", "handoffs", "plan-advisor-timeout.json"), "utf8"),
  );
  assert.equal(handoff.verdict, "TIMED_OUT");
  assert.equal(watchdog.after({ callID: "call-1" }), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a timed-out advisor is skipped and a sealed reviewer is accepted", () => {
  const advisor = degradeSubagentTimeout("plan-advisor", { status: "TIMED_OUT", attempts: 1 });
  assert.equal(advisor.action, "skip_advisor");
  const next = resolveNextAction(
    {
      state: "BRAINSTORMING",
      run_id: "advisor-timeout",
      planning_mode: "standard",
      fast_path: { mode: "standard", enabled: true, advisor_parallel: false },
    },
    { timeouts: { "plan-advisor": { status: "TIMED_OUT", attempts: 1 } } },
  );
  assert.equal(next.action, "write_plan");

  const reviewing = resolveNextAction(
    {
      state: "REVIEWING",
      run_id: "review-timeout",
      verification: { status: "PASSED", phase: "TASK" },
      fast_path: { mode: "standard", enabled: true },
    },
    { timeouts: { reviewer: { status: "TIMED_OUT", attempts: 1 } } },
  );
  assert.equal(reviewing.action, "transition_to_completed");
});

test("an implementer timeout redispatches once and then blocks", () => {
  const root = tempRoot();
  recordSubagentTimeout(root, { role: "implementer", budgetMs: 1000 });
  const first = resolveNextAction(
    { state: "IMPLEMENTING", run_id: "impl-timeout" },
    { worktree: root },
  );
  assert.equal(first.action, "redispatch_once");
  assert.equal(first.agent, "implementer");
  recordSubagentTimeout(root, { role: "implementer", budgetMs: 1000 });
  const second = resolveNextAction(
    { state: "IMPLEMENTING", run_id: "impl-timeout" },
    { worktree: root },
  );
  assert.equal(second.action, "block_for_subagent_timeout");
  const planned = planAdvanceStep(second, {
    state: { state: "IMPLEMENTING", run_id: "impl-timeout" },
    unit: null,
    unit_acceptance: [],
    unit_targets: [],
  });
  assert.equal(planned.stop.reason_code, "SUBAGENT_TIMED_OUT");
  fs.rmSync(root, { recursive: true, force: true });
});

test("review rounds default to one and rise to two for HIGH risk", () => {
  assert.equal(resolveMaxReviewRounds({}), 1);
  assert.equal(resolveMaxReviewRounds({ impact: { risk: "HIGH" } }), 2);
  assert.equal(resolveMaxReviewRounds({ max_review_rounds: 4 }), 4);
  assert.equal(
    resolveMaxReviewRounds({ impact: { risk: "LOW" }, max_review_rounds: 0 }),
    0,
  );
});
