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

test("a fake timer writes TIMED_OUT only after the call returns when abort cannot run", () => {
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
    abortChild(sessionID) {
      aborted.push(sessionID);
      return Promise.resolve({ aborted: true });
    },
    onTimeout(event) {
      recordSubagentTimeout(root, { ...event, run_id: "run-1", unit: "unit-1" });
    },
  });
  watchdog.noteChildSession("parent", "parent");
  watchdog.before(
    { tool: "task", callID: "call-1", sessionID: "parent" },
    { args: { agent: "plan-advisor" } },
  );
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(readSubagentTimeouts(root, "run-1")["plan-advisor"], undefined);
  assert.deepEqual(aborted, []);
  assert.equal(watchdog.after({ callID: "call-1" }), false);
  const saved = readSubagentTimeouts(root, "run-1");
  assert.equal(saved["plan-advisor"].status, "TIMED_OUT");
  assert.equal(saved["plan-advisor"].attempts, 1);
  assert.equal(saved["plan-advisor"].run_id, "run-1");
  assert.equal(
    fs.existsSync(path.join(root, ".opencode", "handoffs", "plan-advisor-timeout.json")),
    false,
  );
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
  assert.equal(reviewing.action, "advance_to_final_verifying");
  assert.match(reviewing.command, /FINAL_VERIFYING/);
});

test("an implementer timeout redispatches once and then blocks", () => {
  const root = tempRoot();
  recordSubagentTimeout(root, {
    role: "implementer",
    budgetMs: 1000,
    run_id: "impl-timeout",
    call_id: "call-a",
    unit: "unit-1",
  });
  const first = resolveNextAction(
    { state: "IMPLEMENTING", run_id: "impl-timeout", current_unit: "unit-1" },
    { worktree: root },
  );
  assert.equal(first.action, "redispatch_once");
  assert.equal(first.agent, "implementer");
  recordSubagentTimeout(root, {
    role: "implementer",
    budgetMs: 1000,
    run_id: "impl-timeout",
    call_id: "call-b",
    unit: "unit-1",
  });
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
