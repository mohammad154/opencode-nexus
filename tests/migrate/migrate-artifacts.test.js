import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  writeRunState,
  readRunState,
  inferRunFromContext,
  createEmptyRunState,
  listRunIds,
} from "../../scripts/lib/migrate-artifacts.js";

function tmpWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-migrate-"));
}

test("writeRunState atomic roundtrip", () => {
  const wt = tmpWorktree();
  const state = createEmptyRunState("run-a");
  writeRunState(wt, state);
  const loaded = readRunState(wt, "run-a");
  assert.equal(loaded.run_id, "run-a");
  assert.equal(loaded.state, "CREATED");
  assert.equal(loaded.workflow, "default");
  assert.deepEqual(listRunIds(wt), ["run-a"]);
});

test("inferRunFromContext maps plan evidence to PLANNED never CLASSIFIED", () => {
  const wt = tmpWorktree();
  fs.mkdirSync(path.join(wt, ".opencode", "plans"), { recursive: true });
  fs.writeFileSync(
    path.join(wt, ".opencode", "CONTEXT.md"),
    "workflow: default\nplan_commit: abc123\n",
    "utf8",
  );
  fs.writeFileSync(path.join(wt, ".opencode", "plans", "PLAN.md"), "# Plan\n");
  const inferred = inferRunFromContext(wt);
  assert.equal(inferred.workflow, "default");
  assert.equal(inferred.state, "PLANNED");
  assert.equal(inferred.profile, undefined);
  assert.ok(inferred._inferred);
  assert.ok(!inferred.transitions.some((t) => t.to === "COMPLETED"));
});

test("inferRunFromContext sees implementer DONE as VERIFYING", () => {
  const wt = tmpWorktree();
  fs.mkdirSync(path.join(wt, ".opencode", "handoffs"), { recursive: true });
  fs.writeFileSync(
    path.join(wt, ".opencode", "CONTEXT.md"),
    "workflow: default\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(wt, ".opencode", "handoffs", "unit-1-implementer.json"),
    JSON.stringify({ status: "DONE", commit: "x" }),
    "utf8",
  );
  const inferred = inferRunFromContext(wt);
  assert.equal(inferred.state, "VERIFYING");
});
