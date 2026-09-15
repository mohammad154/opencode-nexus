import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildReviewPackage,
  assertReviewPackagePresent,
} from "../scripts/lib/review-package.js";
import { resolveNextAction } from "../scripts/lib/next-action.js";

function tempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pkg-"));
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1;\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "base"], { cwd: dir });
  const base = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).stdout.trim();
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 2;\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "head"], { cwd: dir });
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).stdout.trim();
  return { dir, base, head };
}

test("buildReviewPackage writes markdown + meta with BASE..HEAD diff", () => {
  const { dir, base, head } = tempGitRepo();
  fs.mkdirSync(path.join(dir, ".opencode", "plans"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".opencode", "plans", "PLAN.md"),
    "# Plan\n\n- AC: a becomes 2\n",
  );
  const meta = buildReviewPackage(dir, {
    scope: "task",
    runState: {
      run_id: "pkg-run",
      current_unit: "u1",
      acceptance_criteria: ["a becomes 2"],
      head_commit: base,
      implementer_commit: head,
    },
    baseCommit: base,
    headCommit: head,
  });
  assert.equal(meta.ok, true);
  assert.equal(meta.scope, "task");
  assert.equal(meta.base_commit, base);
  assert.equal(meta.head_commit, head);
  assert.ok(meta.changed_files.includes("a.js"));
  const mdPath = path.join(dir, meta.path);
  assert.equal(fs.existsSync(mdPath), true);
  const md = fs.readFileSync(mdPath, "utf8");
  assert.match(md, /no expected verdict/i);
  assert.match(md, /unverified claims/i);
  assert.match(md, /a becomes 2/);
  assert.match(md, /export const a = 2/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("final review package supplies bound task approvals and post-review file changes", () => {
  const { dir, base, head } = tempGitRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 3;\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "post-review change"], { cwd: dir });
  const finalHead = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).stdout.trim();
  const acceptanceCriteria = ["a becomes 2"];
  const reviewHandoff = {
    run_id: "final-review-evidence",
    unit_or_task: "unit-1",
    agent: "reviewer",
    review_scope: "task",
    verdict: "APPROVED",
    reviewed_commit: head,
    acceptance: [
      {
        id: "AC-1",
        status: "PASS",
        evidence: [{ file: "a.js", line: 1, reason: "a has the requested value" }],
      },
    ],
    checks: [
      { category: "correctness", status: "PASS", evidence: "reviewed" },
      { category: "test_quality", status: "PASS", evidence: "reviewed" },
      { category: "impact", status: "PASS", evidence: "reviewed" },
    ],
    files_reviewed: ["a.js"],
  };
  const taskReviewPackage = {
    scope: "task",
    run_id: "final-review-evidence",
    unit_or_task: "unit-1",
    base_commit: base,
    head_commit: head,
    digest_sha256: "a".repeat(64),
    acceptance_criteria: acceptanceCriteria,
    changed_files: ["a.js"],
    production_files: ["a.js"],
  };
  const meta = buildReviewPackage(dir, {
    scope: "final",
    runState: {
      run_id: "final-review-evidence",
      current_unit: "unit-1",
      run_base_commit: base,
      implementer_commit: finalHead,
      task_history: [
        {
          id: "unit-1",
          verdict: "APPROVED",
          reviewed_commit: head,
          acceptance_criteria: acceptanceCriteria,
          review_handoff: reviewHandoff,
          review_package: taskReviewPackage,
        },
        {
          id: "legacy-unit",
          verdict: "APPROVED",
          reviewed_commit: base,
          acceptance_criteria: ["legacy criterion"],
        },
      ],
    },
    headCommit: finalHead,
  });

  assert.equal(meta.previous_task_reviews.length, 2);
  assert.equal(meta.previous_task_reviews[0].review_evidence_bound, true);
  assert.deepEqual(meta.previous_task_reviews[0].files_changed_after_review, ["a.js"]);
  assert.equal(meta.previous_task_reviews[1].review_evidence_bound, false);
  assert.equal(meta.previous_task_reviews[1].files_changed_after_review.length, 1);
  const md = fs.readFileSync(path.join(dir, meta.path), "utf8");
  assert.match(md, /Previous task review evidence/);
  assert.match(md, /review_evidence_bound/);
  assert.match(md, /files_changed_after_review/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("assertReviewPackagePresent enforces scope and path", () => {
  const bad = assertReviewPackagePresent(null, { scope: "task" });
  assert.equal(bad.ok, false);
  const wrongScope = assertReviewPackagePresent(
    {
      scope: "final",
      path: "x.md",
      base_commit: "a",
      head_commit: "b",
    },
    { scope: "task" },
  );
  assert.equal(wrongScope.ok, false);
  const ok = assertReviewPackagePresent(
    {
      scope: "task",
      path: "x.md",
      base_commit: "a",
      head_commit: "b",
    },
    { scope: "task" },
  );
  assert.equal(ok.ok, true);
});

test("resolveNextAction maps FINAL_REVIEWING → final reviewer dispatch", () => {
  const next = resolveNextAction({
    run_id: "r1",
    state: "FINAL_REVIEWING",
  });
  assert.equal(next.action, "dispatch_reviewer");
  assert.equal(next.agent, "reviewer");
  assert.match(next.command, /review-package --scope final/);
  assert.match(next.instruction, /whole-branch|final/i);
});

test("resolveNextAction REVIEWING mentions review-package task scope", () => {
  const next = resolveNextAction({ run_id: "r1", state: "REVIEWING" });
  assert.match(next.command, /review-package --scope task/);
  assert.match(next.instruction, /FINAL_REVIEWING/);
});
