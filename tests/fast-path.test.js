import test from "node:test";
import assert from "node:assert/strict";
import { selectFastPath, sessionPlanLines } from "../scripts/lib/fast-path.js";
import { canTransition, transition } from "../scripts/lib/state-machine.js";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";

const withHistory = { repo_history: true, test_suite: true };
const noTests = { repo_history: true, test_suite: false };

function run(mode = "direct", extra = {}) {
  return {
    ...createEmptyRunState("fast-path"),
    state: "BRAINSTORMING",
    fast_path: {
      enabled: true,
      mode,
      reviewer: "on-second-failure-or-high",
      session_plan: "Goal: ship\nNon-goals: none\nFiles: src/app.js\nCheck: npm test\nStop: escalate",
      ...extra,
    },
  };
}

test("unclassified work defaults to direct and a five-line session plan", () => {
  const decision = selectFastPath({}, { workspace: withHistory });
  assert.equal(decision.mode, "direct");
  assert.equal(decision.plan_file, false);
  assert.equal(decision.plan_advisor, false);
  assert.equal(decision.worktree, false);
  assert.equal(decision.branch, false);
  assert.equal(sessionPlanLines(decision.session_plan).length, 5);
  assert.ok(decision.reasons.includes("UNCLASSIFIED_DEFAULT_DIRECT"));
});

test("three files and 120 lines with history and tests stay standard", () => {
  const decision = selectFastPath(
    { files_changed: 3, estimated_lines: 120 },
    { workspace: withHistory },
  );
  assert.equal(decision.mode, "standard");
  assert.ok(decision.reasons.includes("EVIDENCE_OF_SIZE_OR_RISK"));
});

test("compact evidence selects direct even when the repo has history and tests", () => {
  const decision = selectFastPath(
    {
      files_changed: 4,
      estimated_lines: 140,
      risk: "MEDIUM",
      cohesive_unit: true,
      known_pattern: true,
    },
    { workspace: withHistory },
  );
  assert.equal(decision.mode, "direct");
  assert.ok(decision.reasons.includes("COMPACT_ELIGIBLE"));
});

test("a safety signal stays standard even when there is no test suite", () => {
  const decision = selectFastPath(
    { security_boundary: true, files_changed: 1, estimated_lines: 10 },
    { workspace: noTests },
  );
  assert.equal(decision.mode, "standard");
  assert.ok(decision.reasons.includes("ESCALATE_SIGNAL"));
});

test("no repository history selects direct", () => {
  const decision = selectFastPath(
    { files_changed: 3, estimated_lines: 120 },
    { workspace: { repo_history: false, test_suite: true } },
  );
  assert.equal(decision.mode, "direct");
  assert.ok(decision.reasons.includes("NO_REPO_HISTORY"));
});

test("no test suite selects direct when the change is within the compact size", () => {
  const decision = selectFastPath(
    { files_changed: 2, estimated_lines: 40 },
    { workspace: noTests },
  );
  assert.equal(decision.mode, "direct");
  assert.ok(decision.reasons.includes("NO_TEST_SUITE"));
});

test("an oversized change stays standard even without tests", () => {
  const decision = selectFastPath(
    { files_changed: 6, estimated_lines: 20 },
    { workspace: noTests },
  );
  assert.equal(decision.mode, "standard");
  assert.ok(decision.reasons.includes("EVIDENCE_OF_SIZE"));
});

test("NEXUS_FAST_PATH=0 and explicit deep stay standard", () => {
  const disabled = selectFastPath({}, { workspace: withHistory, env: { NEXUS_FAST_PATH: "0" } });
  assert.equal(disabled.mode, "standard");
  assert.ok(disabled.reasons.includes("FAST_PATH_DISABLED"));
  const deep = selectFastPath(
    { planning_mode: "deep", files_changed: 1, estimated_lines: 10 },
    { workspace: withHistory },
  );
  assert.equal(deep.mode, "standard");
  assert.ok(deep.reasons.includes("EXPLICIT_DEEP"));
});

test("an explicit standard label without size or risk evidence stays direct", () => {
  const decision = selectFastPath(
    { planning_mode: "standard" },
    { workspace: withHistory },
  );
  assert.equal(decision.mode, "direct");
  assert.ok(decision.reasons.includes("EXPLICIT_STANDARD_WITHOUT_EVIDENCE"));
});

test("direct mode can enter IMPLEMENTING without PLAN.md", () => {
  const result = transition(run(), "IMPLEMENTING", {
    session_plan: "Goal: ship\nNon-goals: none\nFiles: src/app.js\nCheck: npm test\nStop: escalate",
    allowed_files: ["src/app.js"],
    acceptance_criteria: ["the change works"],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.state.state, "IMPLEMENTING");
  assert.equal(result.state.current_unit, "unit-1");
});

test("direct mode can verify an orchestrator edit without an implementer handoff", () => {
  const started = transition(run(), "IMPLEMENTING", {
    session_plan: "Goal: ship\nNon-goals: none\nFiles: src/app.js\nCheck: npm test\nStop: escalate",
    allowed_files: ["src/app.js"],
    acceptance_criteria: ["the change works"],
  });
  assert.equal(started.ok, true, JSON.stringify(started.errors));
  const verified = transition(started.state, "VERIFYING", {});
  assert.equal(verified.ok, true, JSON.stringify(verified.errors));
  assert.equal(verified.state.state, "VERIFYING");
});

test("direct mode completes from VERIFYING when the check has not failed twice", () => {
  const state = run("direct", { check_failures: 1 });
  state.state = "VERIFYING";
  state.verification = { status: "PASSED", phase: "TASK" };
  const result = canTransition(state, "COMPLETED", {});
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("HIGH risk in direct mode does not skip the reviewer", () => {
  const state = run("direct", { risk: "HIGH" });
  state.state = "VERIFYING";
  state.verification = { status: "PASSED", phase: "TASK" };
  state.impact = { risk: "HIGH" };
  const result = canTransition(state, "COMPLETED", {});
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /illegal transition/);
});
