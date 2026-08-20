import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveNextAction,
  formatNextActionInjection,
} from "../../scripts/lib/next-action.js";
import { buildRunGateReminder } from "../../scripts/lib/run-gate.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const bin = path.join(root, "bin", "nexus.js");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("resolveNextAction maps IMPLEMENTING → dispatch implementer", () => {
  const next = resolveNextAction({
    run_id: "r1",
    state: "IMPLEMENTING",
  });
  assert.equal(next.action, "dispatch_implementer");
  assert.equal(next.agent, "implementer");
  assert.match(next.instruction, /implementer/i);
  const text = formatNextActionInjection(next);
  assert.match(text, /REQUIRED_DISPATCH: implementer/);
});

test("resolveNextAction maps REVIEWING → dispatch reviewer", () => {
  const next = resolveNextAction({ run_id: "r1", state: "REVIEWING" });
  assert.equal(next.action, "dispatch_reviewer");
  assert.equal(next.agent, "reviewer");
});

test("resolveNextAction maps PLANNED → pre_impact", () => {
  const next = resolveNextAction({ run_id: "r1", state: "PLANNED" });
  assert.equal(next.action, "pre_impact");
  assert.equal(next.agent, null);
  assert.match(next.command || "", /nexus impact/);
});

test("resolveNextAction maps TASK_IMPACT_READY → implementer after transition", () => {
  const next = resolveNextAction({
    run_id: "r1",
    state: "TASK_IMPACT_READY",
  });
  assert.equal(next.agent, "implementer");
  assert.equal(next.action, "transition_then_dispatch");
});

test("resolveNextAction with no state → init_run", () => {
  const next = resolveNextAction(null);
  assert.equal(next.action, "init_run");
});

test("BRAINSTORMING without plan asks to write plan", () => {
  const wt = tempDir("nexus-next-plan-");
  const next = resolveNextAction(
    { run_id: "r1", state: "BRAINSTORMING" },
    { worktree: wt },
  );
  assert.equal(next.action, "write_plan");
  fs.rmSync(wt, { recursive: true, force: true });
});

test("BRAINSTORMING with PLAN.md → transition PLANNED", () => {
  const wt = tempDir("nexus-next-hasplan-");
  const plan = path.join(wt, ".opencode", "plans", "PLAN.md");
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, "# Plan\n");
  const next = resolveNextAction(
    { run_id: "r1", state: "BRAINSTORMING" },
    { worktree: wt },
  );
  assert.equal(next.action, "transition");
  assert.match(next.command || "", /PLANNED/);
  fs.rmSync(wt, { recursive: true, force: true });
});

test("buildRunGateReminder includes Nexus Next Action", () => {
  const text = buildRunGateReminder({
    state: "IMPLEMENTING",
    run_id: "demo",
  });
  assert.match(text, /Nexus Next Action/);
  assert.match(text, /REQUIRED_DISPATCH: implementer/);
});

test("nexus next --json works with no run", () => {
  const wt = tempDir("nexus-next-cli-");
  const result = spawnSync(process.execPath, [bin, "next", "--json"], {
    encoding: "utf8",
    cwd: wt,
    env: { ...process.env, NEXUS_WORKTREE: wt },
  });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.next.action, "init_run");
  fs.rmSync(wt, { recursive: true, force: true });
});

test("nexus run next aliases nexus next", () => {
  const wt = tempDir("nexus-run-next-");
  const result = spawnSync(process.execPath, [bin, "run", "next", "--json"], {
    encoding: "utf8",
    cwd: wt,
    env: { ...process.env, NEXUS_WORKTREE: wt },
  });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.next.action, "init_run");
  fs.rmSync(wt, { recursive: true, force: true });
});

test("nexus next reads active run state", () => {
  const wt = tempDir("nexus-next-active-");
  const runDir = path.join(wt, ".opencode", "runs", "demo");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "state.json"),
    JSON.stringify({
      schema_version: "1.0",
      run_id: "demo",
      state: "REVIEWING",
      workflow: "default",
      execution_mode: "delegated",
      transitions: [],
      updated_at: "2026-08-20T12:00:00.000Z",
    }),
  );
  const result = spawnSync(process.execPath, [bin, "next", "--json"], {
    encoding: "utf8",
    cwd: wt,
    env: { ...process.env, NEXUS_WORKTREE: wt },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const body = JSON.parse(result.stdout);
  assert.equal(body.next.agent, "reviewer");
  assert.equal(body.next.action, "dispatch_reviewer");
  fs.rmSync(wt, { recursive: true, force: true });
});
