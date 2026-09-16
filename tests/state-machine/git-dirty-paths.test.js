import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createEmptyRunState } from "../../scripts/lib/migrate-artifacts.js";
import { buildReviewPackage } from "../../scripts/lib/review-package.js";
import {
  canTransition,
  gitDirtyPaths,
} from "../../scripts/lib/state-machine.js";
import { goodReviewerHandoff } from "../helpers/gate-fixtures.js";

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return String(result.stdout || "").trim();
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-dirty-paths-"));
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
  const runId = "git-dirty-paths-run";
  const unit = "unit-1";
  const state = {
    ...createEmptyRunState(runId),
    state: "REVIEWING",
    worktree: repo.root,
    current_unit: unit,
    execution_units: [{ id: unit }],
    units: [{ id: unit }],
    acceptance_criteria: ["done"],
    head_commit: repo.base,
    implementer_commit: repo.head,
    run_base_commit: repo.base,
    last_implementer_handoff: { agent: "implementer" },
  };
  const review_handoff = goodReviewerHandoff({
    run_id: runId,
    unit_or_task: unit,
    base_commit: repo.base,
    reviewed_commit: repo.head,
    review_scope: "task",
  });
  const review_package = buildReviewPackage(repo.root, {
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
  return { state, review_handoff, review_package };
}

function makeStatusUnavailable(repo) {
  // HEAD and commit-object lookups still work, but `git status` cannot read
  // the corrupted index. This isolates the dirty-path measurement failure.
  fs.writeFileSync(path.join(repo.root, ".git", "index"), "corrupt-index\n");
}

test("gitDirtyPaths preserves successful clean and dirty measurements", (t) => {
  const repo = repository();
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }));

  const clean = gitDirtyPaths(repo.root);
  assert.deepEqual(clean, { available: true, dirty_paths: [] });

  fs.appendFileSync(path.join(repo.root, "src", "app.js"), "export const dirty = true;\n");
  const dirty = gitDirtyPaths(repo.root);
  assert.equal(dirty.available, true);
  assert.deepEqual(dirty.dirty_paths, ["src/app.js"]);
});

test("reviewer workspace mutation authorization rejects unavailable git status", (t) => {
  const repo = repository();
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }));
  const fixture = reviewFixture(repo);
  makeStatusUnavailable(repo);

  const status = gitDirtyPaths(repo.root);
  assert.equal(status.available, false);
  assert.deepEqual(status.dirty_paths, []);
  assert.match(status.error, /git status unavailable/i);

  const result = canTransition(fixture.state, "FINAL_REVIEWING", {
    worktree: repo.root,
    review_handoff: fixture.review_handoff,
    review_package: fixture.review_package,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /reviewer approval rejected: workspace status unavailable/i);
});

test("single-unit final-review reuse rejects unavailable git status", (t) => {
  const repo = repository();
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }));
  const fixture = reviewFixture(repo);
  makeStatusUnavailable(repo);

  const result = canTransition(fixture.state, "FINAL_VERIFYING", {
    worktree: repo.root,
    reuse_final_review: true,
    review_handoff: fixture.review_handoff,
    review_package: fixture.review_package,
  });
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join(" "),
    /single-unit final-review reuse rejected: workspace status unavailable/i,
  );
});
