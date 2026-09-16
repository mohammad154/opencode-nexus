import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createEmptyRunState,
  readRunState,
  writeRunState,
} from "../scripts/lib/migrate-artifacts.js";
import { buildReviewPackage } from "../scripts/lib/review-package.js";
import { canTransition, transition } from "../scripts/lib/state-machine.js";
import {
  goodReviewerHandoff,
} from "./helpers/gate-fixtures.js";

const nexusRun = path.resolve("scripts/nexus-run.js");

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return String(result.stdout || "").trim();
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-authority-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Nexus Test"]);
  git(root, ["config", "user.email", "nexus@example.test"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 2;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "implementation"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  return { root, base, head };
}

function reviewFixture(repo) {
  const runId = "authority-review";
  const unit = "unit-1";
  const state = {
    ...createEmptyRunState(runId),
    state: "REVIEWING",
    worktree: repo.root,
    current_unit: unit,
    acceptance_criteria: ["done"],
    head_commit: repo.base,
    implementer_commit: repo.head,
    run_base_commit: repo.base,
    last_implementer_handoff: { agent: "implementer" },
  };
  const handoff = goodReviewerHandoff({
    run_id: runId,
    unit_or_task: unit,
    base_commit: repo.base,
    reviewed_commit: repo.head,
    review_scope: "task",
  });
  const reviewPackage = buildReviewPackage(repo.root, {
    scope: "task",
    runState: {
      run_id: runId,
      current_unit: unit,
      head_commit: repo.base,
      implementer_commit: repo.head,
      run_base_commit: repo.base,
      acceptance_criteria: ["done"],
    },
    headCommit: repo.head,
  });
  return { state, handoff, reviewPackage };
}

test("CLI rejects forged JSON plan authority without canonical PLAN.md", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plan-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeRunState(root, {
    ...createEmptyRunState("forged-plan"),
    state: "BRAINSTORMING",
    worktree: root,
  });
  const forgedPath = path.join(root, "forged-plan.md");
  fs.writeFileSync(forgedPath, "# caller supplied plan\n");
  const result = spawnSync(
    process.execPath,
    [
      nexusRun,
      "transition",
      "--run-id",
      "forged-plan",
      "--to",
      "PLANNED",
      "--json",
      JSON.stringify({
        plan_exists: true,
        plan_path: forgedPath,
        plan_check: {
          ok: true,
          plan_check: "PASS",
          execution_units: [{ id: "forged-unit" }],
          errors: [],
        },
      }),
    ],
    {
      cwd: root,
      env: { ...process.env, NEXUS_WORKTREE: root },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /canonical|PLAN\.md|plan-check/i);
  assert.equal(readRunState(root, "forged-plan").state, "BRAINSTORMING");
});

test("canonical plan authority rejects a symlinked .opencode root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plan-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plan-symlink-outside-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(outside, "plans"), { recursive: true });
  fs.writeFileSync(path.join(outside, "plans", "PLAN.md"), "# external plan\n");
  fs.symlinkSync(outside, path.join(root, ".opencode"));

  const result = canTransition(
    {
      ...createEmptyRunState("symlink-plan"),
      state: "BRAINSTORMING",
      worktree: root,
    },
    "PLANNED",
    { plan_exists: true, plan_check: { ok: true } },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /filesystem boundary|symlink|canonical/i);
});

test("APPROVED reviewer handoff rejects a missing package and never records null", (t) => {
  const repo = repository();
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }));
  const fixture = reviewFixture(repo);
  const result = canTransition(fixture.state, "FINAL_REVIEWING", {
    worktree: repo.root,
    review_handoff: fixture.handoff,
    review_package: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /review_package|null|APPROVED/i);
});

test("APPROVED reviewer handoff rejects an off-tree package and persists a valid one", (t) => {
  const repo = repository();
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }));
  const fixture = reviewFixture(repo);
  const outside = path.join(os.tmpdir(), `nexus-off-tree-${process.pid}.md`);
  fs.writeFileSync(outside, "off tree\n");
  t.after(() => fs.rmSync(outside, { force: true }));

  const offTree = canTransition(fixture.state, "FINAL_REVIEWING", {
    worktree: repo.root,
    review_handoff: fixture.handoff,
    review_package: {
      ...fixture.reviewPackage,
      path: outside,
      absolute_path: outside,
    },
  });
  assert.equal(offTree.ok, false);
  assert.match(offTree.errors.join(" "), /absolute|outside|canonical|review directory/i);

  const accepted = canTransition(fixture.state, "FINAL_REVIEWING", {
    worktree: repo.root,
    review_handoff: fixture.handoff,
    review_package: fixture.reviewPackage,
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.errors));
  const transitioned = transition(fixture.state, "FINAL_REVIEWING", {
    worktree: repo.root,
    review_handoff: fixture.handoff,
    review_package: fixture.reviewPackage,
  });
  assert.equal(transitioned.ok, true, JSON.stringify(transitioned.errors));
  assert.notEqual(transitioned.state.review_package, null);
  assert.equal(
    transitioned.state.review_package.digest_sha256,
    fixture.reviewPackage.digest_sha256,
  );
});

test("APPROVED reviewer handoff rejects a stale package after the worktree tip advances", (t) => {
  const repo = repository();
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }));
  const fixture = reviewFixture(repo);
  fs.writeFileSync(path.join(repo.root, "src", "app.js"), "export const value = 3;\n");
  git(repo.root, ["add", "src/app.js"]);
  git(repo.root, ["commit", "--quiet", "-m", "later change"]);

  const result = canTransition(fixture.state, "FINAL_REVIEWING", {
    worktree: repo.root,
    review_handoff: fixture.handoff,
    review_package: fixture.reviewPackage,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /current HEAD|stale|head_commit/i);
});
