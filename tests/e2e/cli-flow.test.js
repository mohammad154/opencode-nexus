import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runCli = path.join(repoRoot, "scripts", "nexus-run.js");
const temporaryRoots = [];

function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-e2e-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-"));
  temporaryRoots.push(root, home);
  const git = spawnSync("git", ["init", "--quiet", root], {
    encoding: "utf8",
  });
  assert.equal(git.status, 0, git.stderr);
  return { root, home };
}

function invoke(worktree, home, args) {
  const result = spawnSync(process.execPath, [runCli, ...args], {
    cwd: worktree,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      NEXUS_WORKTREE: worktree,
    },
  });
  assert.equal(
    result.status,
    0,
    `${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

function json(value) {
  return JSON.stringify(value);
}

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

test("nexus-run completes a full CLI workflow in a temporary repository", () => {
  const { root, home } = makeTempRepo();
  const runId = "e2e-complete";
  const head = "e2e-head";

  const initialized = invoke(root, home, ["init", "--run-id", runId]);
  assert.equal(initialized.state.state, "CREATED");

  const classified = invoke(root, home, [
    "classify",
    "--run-id",
    runId,
    "--apply",
    "--json",
    json({
      filesChanged: 1,
      estimatedLines: 10,
      changeClass: "small-feature-with-tests",
      focusedValidation: true,
    }),
  ]);
  assert.equal(classified.state.state, "CLASSIFIED");
  assert.equal(classified.state.review_level, "unified");

  invoke(root, home, ["transition", "--run-id", runId, "--to", "PLANNED", "--plan-skip"]);
  invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "GRAPH_READY",
    "--json",
    json({ graph: { ok: true, confidence: 0.95, nodes: 1, edges: 0 } }),
  ]);
  invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "BLAST_READY",
    "--json",
    json({
      blast: { risk: "LOW", score: 0, uncertainties: [] },
    }),
  ]);
  invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "IMPLEMENTING",
    "--json",
    json({
      branch: "e2e/complete",
      acceptance_criteria: ["the CLI flow reaches COMPLETED"],
      drift: {
        schema_version: "1.0",
        drift: "NONE",
        reasons: [],
        plan_commit: "e2e-plan",
        current_head: head,
        commit_distance: 0,
        anchors_broken: [],
        merge_base_changed: false,
      },
    }),
  ]);

  const implementer = {
    schema_version: "1.0",
    run_id: runId,
    status: "DONE",
    commit: head,
    reviewed_commit: head,
    verification_gates: [{ cmd: "npm test", pass: true }],
    drift_check: { plan_commit: "e2e-plan", current_head: head, pass: true },
    blast: { risk: "LOW", verified: true, callers_checked: [] },
  };
  invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "VERIFYING",
    "--json",
    json({ implementer_handoff: implementer }),
  ]);
  invoke(root, home, ["transition", "--run-id", runId, "--to", "REVIEWING"]);

  const completed = invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "COMPLETED",
    "--json",
    json({
      unified_handoff: {
        schema_version: "1.0",
        run_id: runId,
        verdict: "APPROVED",
        reviewed_commit: head,
        blast: { pass: true, risk: "LOW" },
      },
    }),
  ]);
  assert.equal(completed.state.state, "COMPLETED");

  const status = invoke(root, home, ["status", "--run-id", runId]);
  assert.equal(status.state.state, "COMPLETED");
  assert.equal(status.state.transitions.at(-1).to, "COMPLETED");
});
