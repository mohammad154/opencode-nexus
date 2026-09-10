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
import { sealProviderArtifact } from "../../scripts/lib/artifact-seal.js";

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

test("legacy sealed successful verification migrates to PASSED", () => {
  const wt = tmpWorktree();
  const runId = "legacy-verified";
  const state = {
    ...createEmptyRunState(runId),
    state: "VERIFYING",
    provider_verification: sealProviderArtifact({ ok: true, results: [{ pass: true }] }, "abc123"),
  };
  delete state.verification;
  delete state.verification_status;
  const file = path.join(wt, ".opencode", "runs", runId, "state.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");

  const migrated = readRunState(wt, runId);
  assert.equal(migrated.verification_status, "PASSED");
  assert.equal(migrated.verification.status, "PASSED");
  assert.equal(migrated.verification.phase, "TASK");
  assert.equal(migrated.verification.worktree_head, "abc123");
});

test("legacy invalid or missing verification never migrates to PASSED", () => {
  const wt = tmpWorktree();
  for (const [runId, provider_verification] of [
    ["legacy-missing", undefined],
    ["legacy-tampered", { ok: true, provider_validated: true, artifact_digest: "sha256:forged" }],
  ]) {
    const state = { ...createEmptyRunState(runId), state: "VERIFYING" };
    if (provider_verification) state.provider_verification = provider_verification;
    delete state.verification;
    delete state.verification_status;
    const file = path.join(wt, ".opencode", "runs", runId, "state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");

    const migrated = readRunState(wt, runId);
    assert.equal(migrated.verification_status, "PENDING", runId);
    assert.equal(migrated.verification.status, "PENDING", runId);
  }
});
