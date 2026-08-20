import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  assertScopeLock,
  getChangedFilesFromGit,
  buildFreshImplementerContext,
} from "../scripts/lib/scope-lock.js";
import {
  canTransition,
  transition,
} from "../scripts/lib/state-machine.js";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import {
  goodImplementerHandoff,
  mockTrustProviders,
  sealedVerification,
  sealedImpact,
} from "./helpers/gate-fixtures.js";

function initGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-scope-lock-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });

  // Initial base commit
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "base.js"), "// base\n");
  fs.writeFileSync(path.join(dir, "src", "feature.js"), "// feature v1\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial base commit"], { cwd: dir });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();

  return { dir, baseCommit };
}

test("assertScopeLock unit checks", () => {
  // Empty scope fails closed
  const unbound = assertScopeLock({ allowed_files: [], changed_files: ["src/a.js"] });
  assert.equal(unbound.ok, false);
  assert.equal(unbound.code, "SCOPE_UNBOUND");

  // In-scope passes
  const inScope = assertScopeLock({
    allowed_files: ["src/a.js", "src/b.js"],
    changed_files: ["src/a.js"],
  });
  assert.equal(inScope.ok, true);

  // Out-of-scope fails with SCOPE_EXPANSION_REQUIRED
  const outScope = assertScopeLock({
    allowed_files: ["src/a.js"],
    changed_files: ["src/a.js", "src/unauthorized.js"],
  });
  assert.equal(outScope.ok, false);
  assert.equal(outScope.code, "SCOPE_EXPANSION_REQUIRED");
  assert.deepEqual(outScope.extras, ["src/unauthorized.js"]);

  // Glob pattern support
  const globScope = assertScopeLock({
    allowed_files: ["src/**/*.js", "docs/*.md"],
    changed_files: ["src/components/button.js", "docs/readme.md"],
  });
  assert.equal(globScope.ok, true);
});

test("getChangedFilesFromGit derives changed files between base and implementer commit", () => {
  const { dir, baseCommit } = initGitRepo();
  try {
    fs.writeFileSync(path.join(dir, "src", "feature.js"), "// feature v2\n");
    fs.writeFileSync(path.join(dir, "src", "newfile.js"), "// new file\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "implement feature"], { cwd: dir });
    const implCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

    const changed = getChangedFilesFromGit(dir, {
      base_commit: baseCommit,
      implementer_commit: implCommit,
    });
    assert.ok(changed);
    assert.deepEqual(
      [...changed].sort(),
      ["src/feature.js", "src/newfile.js"].sort(),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transition to VERIFYING succeeds when actual git diff is within allowed_files", () => {
  const { dir, baseCommit } = initGitRepo();
  try {
    fs.writeFileSync(path.join(dir, "src", "feature.js"), "// feature v2\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "feature commit in scope"], { cwd: dir });
    const implCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

    const state = {
      ...createEmptyRunState("scope-test-1"),
      state: "IMPLEMENTING",
      head_commit: baseCommit,
      worktree: dir,
      allowed_files: ["src/feature.js"],
    };

    const providers = mockTrustProviders();
    const canRes = canTransition(state, "VERIFYING", {
      worktree: dir,
      provider_verification: sealedVerification(),
      post_impact: sealedImpact({ phase: "post" }),
      implementer_handoff: goodImplementerHandoff({
        run_id: "scope-test-1",
        base_commit: baseCommit,
        commit: implCommit,
      }),
    });
    assert.equal(canRes.ok, true, JSON.stringify(canRes.errors));

    const transRes = transition(
      state,
      "VERIFYING",
      {
        worktree: dir,
        provider_verification: sealedVerification(),
        post_impact: sealedImpact({ phase: "post" }),
        implementer_handoff: goodImplementerHandoff({
          run_id: "scope-test-1",
          base_commit: baseCommit,
          commit: implCommit,
        }),
      },
      providers,
    );
    assert.equal(transRes.ok, true, JSON.stringify(transRes.errors));
    assert.equal(transRes.state.state, "VERIFYING");
    assert.equal(transRes.state.implementer_commit, implCommit);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transition to VERIFYING fails or blocks when actual git diff exceeds allowed_files", () => {
  const { dir, baseCommit } = initGitRepo();
  try {
    fs.writeFileSync(path.join(dir, "src", "feature.js"), "// feature v2\n");
    fs.writeFileSync(path.join(dir, "src", "unauthorized.js"), "// unauthorized edit\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "feature commit with out of scope file"], { cwd: dir });
    const implCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

    const state = {
      ...createEmptyRunState("scope-test-2"),
      state: "IMPLEMENTING",
      head_commit: baseCommit,
      worktree: dir,
      allowed_files: ["src/feature.js"],
    };

    const providers = mockTrustProviders();

    // canTransition fails
    const canRes = canTransition(state, "VERIFYING", {
      worktree: dir,
      provider_verification: sealedVerification(),
      post_impact: sealedImpact({ phase: "post" }),
      implementer_handoff: goodImplementerHandoff({
        run_id: "scope-test-2",
        base_commit: baseCommit,
        commit: implCommit,
      }),
    });
    assert.equal(canRes.ok, false);
    assert.ok(
      canRes.errors.some((e) => e.includes("SCOPE_EXPANSION_REQUIRED")),
      `Expected SCOPE_EXPANSION_REQUIRED error, got: ${JSON.stringify(canRes.errors)}`,
    );

    // transition to VERIFYING fails
    const transRes = transition(
      state,
      "VERIFYING",
      {
        worktree: dir,
        provider_verification: sealedVerification(),
        post_impact: sealedImpact({ phase: "post" }),
        implementer_handoff: goodImplementerHandoff({
          run_id: "scope-test-2",
          base_commit: baseCommit,
          commit: implCommit,
        }),
      },
      providers,
    );
    assert.equal(transRes.ok, false);
    assert.ok(
      transRes.errors.some((e) => e.includes("SCOPE_EXPANSION_REQUIRED")),
      `Expected SCOPE_EXPANSION_REQUIRED in transition errors, got: ${JSON.stringify(transRes.errors)}`,
    );

    // Can transition to BLOCKED with SCOPE_EXPANSION_REQUIRED
    const blockRes = transition(
      state,
      "BLOCKED",
      {
        block_code: "SCOPE_EXPANSION_REQUIRED",
        block_reason: "Out-of-scope edits detected in git diff: src/unauthorized.js",
      },
      providers,
    );
    assert.equal(blockRes.ok, true, JSON.stringify(blockRes.errors));
    assert.equal(blockRes.state.state, "BLOCKED");
    assert.equal(blockRes.state.block_code, "SCOPE_EXPANSION_REQUIRED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transition to VERIFYING rejects bypass when caller passes lying ctx.changed_files", () => {
  const { dir, baseCommit } = initGitRepo();
  try {
    fs.writeFileSync(path.join(dir, "src", "feature.js"), "// feature v2\n");
    fs.writeFileSync(path.join(dir, "src", "unauthorized.js"), "// unauthorized edit\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "feature commit with out of scope file"], { cwd: dir });
    const implCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

    const state = {
      ...createEmptyRunState("scope-test-3"),
      state: "IMPLEMENTING",
      head_commit: baseCommit,
      worktree: dir,
      allowed_files: ["src/feature.js"],
    };

    // Caller attempts to fake changed_files to only contain allowed files
    const canRes = canTransition(state, "VERIFYING", {
      worktree: dir,
      changed_files: ["src/feature.js"],
      provider_verification: sealedVerification(),
      post_impact: sealedImpact({ phase: "post" }),
      implementer_handoff: goodImplementerHandoff({
        run_id: "scope-test-3",
        base_commit: baseCommit,
        commit: implCommit,
      }),
    });
    // Authoritative git diff must catch the real out-of-scope file
    assert.equal(canRes.ok, false);
    assert.ok(
      canRes.errors.some((e) => e.includes("SCOPE_EXPANSION_REQUIRED")),
      `Expected SCOPE_EXPANSION_REQUIRED error, got: ${JSON.stringify(canRes.errors)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transition to VERIFYING checks implementer_context.allowed_files and untracked files", () => {
  const { dir, baseCommit } = initGitRepo();
  try {
    fs.writeFileSync(path.join(dir, "src", "feature.js"), "// feature v2\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "feature commit"], { cwd: dir });
    const implCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

    // Add untracked out-of-scope file in worktree
    fs.writeFileSync(path.join(dir, "src", "untracked_leak.js"), "// dirty untracked\n");

    const state = {
      ...createEmptyRunState("scope-test-4"),
      state: "IMPLEMENTING",
      head_commit: baseCommit,
      worktree: dir,
      implementer_context: buildFreshImplementerContext({
        task: "task-1",
        allowed_files: ["src/feature.js"],
      }),
    };

    const canRes = canTransition(state, "VERIFYING", {
      worktree: dir,
      provider_verification: sealedVerification(),
      post_impact: sealedImpact({ phase: "post" }),
      implementer_handoff: goodImplementerHandoff({
        run_id: "scope-test-4",
        base_commit: baseCommit,
        commit: implCommit,
      }),
    });
    assert.equal(canRes.ok, false);
    assert.ok(
      canRes.errors.some((e) => e.includes("SCOPE_EXPANSION_REQUIRED")),
      `Expected SCOPE_EXPANSION_REQUIRED for untracked out-of-scope file, got: ${JSON.stringify(canRes.errors)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
