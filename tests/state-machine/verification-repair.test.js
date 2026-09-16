import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import { sealProviderArtifact } from "../../scripts/lib/artifact-seal.js";
import { canTransition, transition } from "../../scripts/lib/state-machine.js";
import { mockTrustProviders, sealedImpact } from "../helpers/gate-fixtures.js";

function git(worktree, args) {
  const result = spawnSync("git", args, {
    cwd: worktree,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Nexus Test",
      GIT_AUTHOR_EMAIL: "nexus-test@example.invalid",
      GIT_COMMITTER_NAME: "Nexus Test",
      GIT_COMMITTER_EMAIL: "nexus-test@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || "").trim();
}

function failedArtifact(head, overrides = {}) {
  return sealProviderArtifact(
    {
      schema_version: "1.0",
      ok: false,
      results: [{ id: "test", status: "FAILED", pass: false, exit_code: 1 }],
      workspace_integrity_available: true,
      workspace_clean: true,
      timed_out: false,
      ...overrides,
    },
    head,
  );
}

function failedState({ runId = "verification-repair", state = "VERIFYING", head, artifact, attempts = 0 } = {}) {
  const phase = state === "FINAL_VERIFYING" ? "FINAL" : "TASK";
  return {
    run_id: runId,
    state,
    worktree: artifact.worktree,
    verification_status: "FAILED",
    verification_repair_attempts: attempts,
    verification: {
      status: "FAILED",
      phase,
      worktree_head: head,
      artifact_digest: artifact.artifact_digest,
      failure_reason: "VERIFICATION_FAILED",
      workspace_integrity_available: true,
      workspace_clean: true,
    },
    ...(phase === "FINAL"
      ? { final_verification: artifact }
      : { provider_verification: artifact }),
  };
}

function fixture(t) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-state-repair-"));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.writeFileSync(path.join(worktree, "README.md"), "fixture\n");
  git(worktree, ["init"]);
  git(worktree, ["add", "."]);
  git(worktree, ["commit", "-m", "fixture"]);
  const head = git(worktree, ["rev-parse", "HEAD"]);
  const artifact = failedArtifact(head);
  return { worktree, head, artifact };
}

function repairEvidence(artifact, worktree, phase = "TASK") {
  return {
    worktree,
    verification_repair: {
      phase,
      artifact_digest: artifact.artifact_digest,
    },
    impact: sealedImpact({ phase: "pre", pre_impact: true }),
  };
}

test("VERIFYING failed check can re-enter TASK_IMPACT_READY once and records the attempt", (t) => {
  const { worktree, head, artifact } = fixture(t);
  const state = failedState({ head, artifact });
  state.worktree = worktree;
  const evidence = repairEvidence(artifact, worktree);

  const allowed = canTransition(state, "TASK_IMPACT_READY", evidence);
  assert.equal(allowed.ok, true, JSON.stringify(allowed.errors));

  const result = transition(state, "TASK_IMPACT_READY", evidence, mockTrustProviders());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.state.state, "TASK_IMPACT_READY");
  assert.equal(result.state.verification_repair_attempts, 1);
  assert.equal(result.state.last_verification_repair.phase, "TASK");
});

test("FINAL_VERIFYING repair re-enters the task loop but direct implementation remains illegal", (t) => {
  const { worktree, head, artifact } = fixture(t);
  const state = failedState({ state: "FINAL_VERIFYING", head, artifact });
  state.worktree = worktree;
  const evidence = repairEvidence(artifact, worktree, "FINAL");

  const allowed = canTransition(state, "TASK_IMPACT_READY", evidence);
  assert.equal(allowed.ok, true, JSON.stringify(allowed.errors));
  const illegal = canTransition(state, "IMPLEMENTING", {});
  assert.equal(illegal.ok, false);
});

test("verification repair rejects stale, dirty, unavailable, and exhausted evidence", (t) => {
  const { worktree, head, artifact } = fixture(t);
  const base = failedState({ head, artifact });

  const stale = {
    ...base,
    verification: { ...base.verification, worktree_head: "stale-head" },
  };
  const staleResult = canTransition(stale, "TASK_IMPACT_READY", repairEvidence(artifact, worktree));
  assert.equal(staleResult.ok, false);
  assert.match(staleResult.errors.join(" "), /current HEAD/i);

  const dirtyArtifact = failedArtifact(head, {
    workspace_clean: false,
    dirty_paths: ["src/app.js"],
  });
  const dirty = failedState({ head, artifact: dirtyArtifact });
  dirty.worktree = worktree;
  const dirtyResult = canTransition(
    dirty,
    "TASK_IMPACT_READY",
    repairEvidence(dirtyArtifact, worktree),
  );
  assert.equal(dirtyResult.ok, false);
  assert.match(dirtyResult.errors.join(" "), /clean workspace/i);

  const unavailableArtifact = failedArtifact(head, {
    workspace_integrity_available: false,
    workspace_integrity_error: "status unavailable",
  });
  const unavailable = failedState({ head, artifact: unavailableArtifact });
  unavailable.worktree = worktree;
  const unavailableResult = canTransition(
    unavailable,
    "TASK_IMPACT_READY",
    repairEvidence(unavailableArtifact, worktree),
  );
  assert.equal(unavailableResult.ok, false);
  assert.match(unavailableResult.errors.join(" "), /available clean workspace/i);

  const exhausted = failedState({ head, artifact, attempts: 1 });
  exhausted.worktree = worktree;
  const exhaustedResult = canTransition(
    exhausted,
    "TASK_IMPACT_READY",
    repairEvidence(artifact, worktree),
  );
  assert.equal(exhaustedResult.ok, false);
  assert.match(exhaustedResult.errors.join(" "), /VERIFICATION_REPAIR_EXHAUSTED/);
});
