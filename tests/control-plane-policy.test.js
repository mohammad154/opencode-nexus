import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  captureControlPlaneSnapshot,
  verifyControlPlaneSnapshot,
} from "../scripts/lib/control-plane.js";
import {
  createPolicySnapshot,
  trustedPolicyForState,
  validatePolicySnapshot,
} from "../scripts/lib/policy-snapshot.js";
import { createEmptyRunState, writeRunState } from "../scripts/lib/migrate-artifacts.js";
import { discoverVerification } from "../scripts/lib/verification/discover.js";
import { analyzeImpact } from "../scripts/lib/impact/analyze.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test("control-plane snapshot detects protected mutation but permits handoffs", () => {
  const worktree = tempDir("nexus-control-plane-");
  write(path.join(worktree, ".opencode", "runs", "run-1", "state.json"), '{"state":"IMPLEMENTING"}\n');
  write(path.join(worktree, ".opencode", "config", "scope-policy.json"), '{"ignored":["src/generated/**"]}\n');
  write(path.join(worktree, ".opencode", "handoffs", "unit-1.json"), "handoff\n");

  const captured = captureControlPlaneSnapshot(worktree, { runId: "run-1" });
  assert.equal(captured.ok, true, captured.error);
  assert.equal(verifyControlPlaneSnapshot(worktree, { runId: "run-1" }).ok, true);

  write(path.join(worktree, ".opencode", "handoffs", "unit-2.json"), "new handoff\n");
  assert.equal(verifyControlPlaneSnapshot(worktree, { runId: "run-1" }).ok, true);

  write(path.join(worktree, ".opencode", "config", "scope-policy.json"), '{"ignored":[]}\n');
  const tampered = verifyControlPlaneSnapshot(worktree, { runId: "run-1" });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.code, "CONTROL_PLANE_TAMPERED");
});

test("trusted policy remains the pre-implementation snapshot", () => {
  const worktree = tempDir("nexus-policy-snapshot-");
  write(
    path.join(worktree, ".opencode", "config", "scope-policy.json"),
    JSON.stringify({ ignored: ["candidate/**"] }),
  );
  const snapshot = createPolicySnapshot(worktree, {
    runId: "run-2",
    unitOrTask: "unit-2",
    baseCommit: "base",
    planCommit: "plan",
    sourceCommit: "source",
  });
  const state = {
    run_id: "run-2",
    current_unit: "unit-2",
    run_base_commit: "base",
    plan_commit: "plan",
    head_commit: "source",
    policy_snapshot: snapshot,
    policy_snapshot_required: true,
  };
  const trusted = trustedPolicyForState(state, worktree, { required: true });
  assert.ok(trusted.ignored_patterns.includes("candidate/**"));

  write(
    path.join(worktree, ".opencode", "config", "scope-policy.json"),
    JSON.stringify({ ignored: ["candidate/**", "src/**"] }),
  );
  const stillTrusted = trustedPolicyForState(state, worktree, { required: true });
  assert.deepEqual(stillTrusted.ignored_patterns, trusted.ignored_patterns);

  const checked = validatePolicySnapshot(snapshot, {
    runId: "run-2",
    unitOrTask: "unit-2",
    baseCommit: "base",
    planCommit: "plan",
    sourceCommit: "source",
  });
  assert.equal(checked.ok, true, checked.errors?.join("; "));
  assert.equal(
    trustedPolicyForState(
      { ...state, policy_snapshot: { ...snapshot, policy_digest: "sha256:tampered" } },
      worktree,
      { required: true },
    ),
    null,
  );
});

test("CLI blocks VERIFYING when the protected control plane changed", () => {
  const worktree = tempDir("nexus-control-plane-cli-");
  const policyPath = path.join(worktree, ".opencode", "config", "scope-policy.json");
  write(policyPath, JSON.stringify({ ignored: [] }));
  const snapshot = createPolicySnapshot(worktree, {
    runId: "run-cli-tamper",
    unitOrTask: "unit-cli",
    baseCommit: "base",
    planCommit: "plan",
    sourceCommit: "source",
  });
  const state = createEmptyRunState("run-cli-tamper", {
    state: "IMPLEMENTING",
    current_unit: "unit-cli",
    run_base_commit: "base",
    plan_commit: "plan",
    head_commit: "source",
    branch: "feature",
    policy_snapshot: snapshot,
    policy_snapshot_required: true,
  });
  writeRunState(worktree, state);
  assert.equal(captureControlPlaneSnapshot(worktree, { runId: state.run_id }).ok, true);
  write(policyPath, JSON.stringify({ ignored: ["src/**"] }));

  const cli = path.resolve(import.meta.dirname, "../scripts/nexus-run.js");
  const result = spawnSync(
    process.execPath,
    [cli, "transition", "--run-id", state.run_id, "--to", "VERIFYING"],
    { cwd: worktree, env: { ...process.env, NEXUS_WORKTREE: worktree }, encoding: "utf8" },
  );
  assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /CONTROL_PLANE_TAMPERED/);
  const persisted = JSON.parse(fs.readFileSync(path.join(worktree, ".opencode/runs/run-cli-tamper/state.json"), "utf8"));
  assert.equal(persisted.state, "BLOCKED");
  assert.equal(persisted.block_code, "CONTROL_PLANE_TAMPERED");
});

test("verification discovery honors the frozen policy after candidate policy changes", () => {
  const worktree = tempDir("nexus-policy-provider-");
  write(path.join(worktree, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  write(path.join(worktree, "tests", "safe.test.js"), "test('safe',()=>{});\n");
  const snapshot = createPolicySnapshot(worktree, {
    runId: "run-provider",
    unitOrTask: "unit-provider",
    baseCommit: "base",
    planCommit: "plan",
    sourceCommit: "source",
  });
  const state = {
    run_id: "run-provider",
    current_unit: "unit-provider",
    run_base_commit: "base",
    plan_commit: "plan",
    head_commit: "source",
    policy_snapshot: snapshot,
    policy_snapshot_required: true,
  };
  write(
    path.join(worktree, ".opencode", "config", "scope-policy.json"),
    JSON.stringify({ ignored: ["tests/**"] }),
  );
  const policy = trustedPolicyForState(state, worktree, { required: true });
  const plan = discoverVerification(worktree, {
    related_tests: ["tests/safe.test.js"],
    policy,
  });
  assert.deepEqual(plan.related_tests, ["tests/safe.test.js"]);
});

test("impact analysis keeps candidate-edited source visible under frozen policy", () => {
  const worktree = tempDir("nexus-policy-impact-");
  const git = (...args) => spawnSync("git", args, { cwd: worktree, encoding: "utf8" });
  assert.equal(git("init", "--quiet").status, 0);
  assert.equal(git("config", "user.name", "Nexus Test").status, 0);
  assert.equal(git("config", "user.email", "nexus@example.test").status, 0);
  write(path.join(worktree, "src", "value.js"), "export const value = 1;\n");
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("commit", "-qm", "base").status, 0);
  const base = String(git("rev-parse", "HEAD").stdout).trim();

  const snapshot = createPolicySnapshot(worktree, {
    runId: "run-impact",
    unitOrTask: "unit-impact",
    baseCommit: base,
    planCommit: base,
    sourceCommit: base,
  });
  const state = {
    run_id: "run-impact",
    current_unit: "unit-impact",
    run_base_commit: base,
    plan_commit: base,
    head_commit: base,
    policy_snapshot: snapshot,
    policy_snapshot_required: true,
  };
  write(
    path.join(worktree, ".opencode", "config", "scope-policy.json"),
    JSON.stringify({ ignored: ["src/**"] }),
  );
  write(path.join(worktree, "src", "value.js"), "export const value = 2;\n");
  const report = analyzeImpact(worktree, {
    base: "HEAD",
    policy: trustedPolicyForState(state, worktree, { required: true }),
    persistCache: false,
  });
  assert.equal(report.ok, true);
  assert.ok(report.changed_files.some((entry) => entry.path === "src/value.js"));
});
