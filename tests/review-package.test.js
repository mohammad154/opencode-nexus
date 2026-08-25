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
