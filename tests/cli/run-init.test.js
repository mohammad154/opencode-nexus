import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEvidence } from "../../scripts/nexus-run.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runCli = path.join(repoRoot, "scripts", "nexus-run.js");

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-runinit-"));
  spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  return root;
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return String(result.stdout || "").trim();
}

function invoke(worktree, args) {
  return spawnSync(process.execPath, [runCli, ...args], {
    cwd: worktree,
    encoding: "utf8",
    env: { ...process.env, NEXUS_WORKTREE: worktree },
  });
}

test("default run id is unique across two same-day inits", (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = JSON.parse(invoke(root, ["init"]).stdout);
  const b = JSON.parse(invoke(root, ["init"]).stdout);
  assert.notEqual(a.state.run_id, b.state.run_id);
  assert.match(a.state.run_id, /^run-\d{4}-\d{2}-\d{2}T/);
});

test("nexus run init refuses to overwrite an existing run without --force", (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = invoke(root, ["init", "--run-id", "dup"]);
  assert.equal(first.status, 0, first.stderr);

  const second = invoke(root, ["init", "--run-id", "dup"]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists/);

  const forced = invoke(root, ["init", "--run-id", "dup", "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
});

test("nexus run init preserves corrupt state unless --force is explicit", (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, ".opencode", "runs", "corrupt", "state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const corrupt = "{ this is not valid JSON\n";
  fs.writeFileSync(statePath, corrupt, "utf8");

  const refused = invoke(root, ["init", "--run-id", "corrupt"]);
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /JSON|Unexpected token|invalid/i);
  assert.equal(fs.readFileSync(statePath, "utf8"), corrupt);

  const forced = invoke(root, ["init", "--run-id", "corrupt", "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).run_id, "corrupt");
});

test("review-handoff-file preserves the complete reviewer artifact", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-review-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handoff = {
    schema_version: "1.2",
    run_id: "review-file",
    unit_or_task: "unit-1",
    agent: "reviewer",
    verdict: "APPROVED",
    acceptance: [{ id: "AC-1", status: "PASS", evidence: [{ file: "src/app.js", reason: "covered" }] }],
    files_reviewed: ["src/app.js"],
    checks: [{ category: "correctness", status: "PASS", evidence: "checked" }],
  };
  const handoffPath = path.join(root, "reviewer.json");
  fs.writeFileSync(handoffPath, JSON.stringify(handoff));
  const evidence = loadEvidence({
    "review-handoff-file": handoffPath,
    json: JSON.stringify({ impact: { risk: "LOW" } }),
  });
  assert.deepEqual(evidence.review_handoff, handoff);
  assert.deepEqual(evidence.impact, { risk: "LOW" });
});

test("can-transition ignores an evidence file that redirects worktree identity", (t) => {
  const root = makeRepo();
  const redirected = makeRepo();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(redirected, { recursive: true, force: true });
  });

  for (const repo of [root, redirected]) {
    git(repo, ["config", "user.name", "Nexus Test"]);
    git(repo, ["config", "user.email", "nexus@example.test"]);
    fs.writeFileSync(
      path.join(repo, "app.js"),
      repo === redirected ? "export const redirected = true;\n" : "export const app = true;\n",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", repo === redirected ? "redirected fixture" : "fixture"]);
  }
  const rootHead = git(root, ["rev-parse", "HEAD"]);
  const redirectedHead = git(redirected, ["rev-parse", "HEAD"]);
  const branch = git(root, ["branch", "--show-current"]);

  const initialized = JSON.parse(invoke(root, ["init", "--run-id", "redirected-run"]).stdout);
  const statePath = path.join(root, ".opencode", "runs", "redirected-run", "state.json");
  const state = initialized.state;
  state.state = "TASK_IMPACT_READY";
  state.plan_commit = rootHead;
  state.branch = branch;
  state.allowed_files = ["app.js"];
  state.impact = { risk: "LOW", changed_files: ["app.js"] };
  state.impact_consumed_for_implement = false;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const evidencePath = path.join(root, "redirect-evidence.json");
  fs.writeFileSync(
    evidencePath,
    JSON.stringify({
      worktree: redirected,
      branch,
      current_unit: "unit-1",
      acceptance_criteria: ["the change works"],
      allowed_files: ["app.js"],
      impact: { risk: "LOW", changed_files: ["app.js"] },
      drift: {
        schema_version: "1.0",
        plan_commit: rootHead,
        current_head: redirectedHead,
        drift: "NONE",
        reasons: [],
      },
    }),
  );

  const result = invoke(
    root,
    [
      "can-transition",
      "--run-id",
      "redirected-run",
      "--to",
      "IMPLEMENTING",
      "--evidence",
      evidencePath,
    ],
  );
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stdout, /worktree HEAD.*does not match/i);
});
