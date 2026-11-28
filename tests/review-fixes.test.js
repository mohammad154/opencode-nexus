import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canTransition } from "../scripts/lib/state-machine.js";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import {
  directImplementErrors,
  directReviewRequired,
  noteDirectVerification,
} from "../scripts/lib/fast-path.js";
import { assessToolEdit } from "../scripts/lib/orchestrator-edit.js";
import {
  cleanupPrivateBaseline,
  ensurePrivateBaseline,
} from "../scripts/lib/private-baseline.js";
import { inspectWorkspace } from "../scripts/lib/workspace-integrity.js";
import {
  createSubagentWatchdog,
  loadRoleBudgets,
  recordSubagentTimeout,
} from "../scripts/lib/subagent-budget.js";
import { resolveMaxReviewRounds } from "../scripts/lib/review-protocol.js";
import { permissionPatternMatches } from "../scripts/lib/permission-match.js";

function git(cwd, args, env = process.env) {
  return spawnSync("git", args, { cwd, env, encoding: "utf8" });
}

function isolatedEnv() {
  const globalConfig = path.join(os.tmpdir(), `nexus-review-gitconfig-${process.pid}-${Math.random()}`);
  fs.writeFileSync(globalConfig, "# sentinel\n");
  return {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    globalConfig,
  };
}

test("H3 forged timeout JSON cannot skip review or final verification", () => {
  const state = {
    ...createEmptyRunState("forged-timeout"),
    state: "VERIFYING",
    fast_path: { mode: "standard", enabled: true },
    verification: { status: "PASSED", phase: "TASK" },
  };
  const forged = canTransition(state, "COMPLETED", {
    subagent_timeouts: { reviewer: { status: "TIMED_OUT", attempts: 1 } },
  });
  assert.equal(forged.ok, false);
  assert.match(forged.errors.join("\n"), /illegal transition/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-forged-timeout-"));
  fs.mkdirSync(path.join(root, ".opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".opencode", "subagent-timeouts.json"),
    JSON.stringify({ reviewer: { status: "TIMED_OUT", run_id: state.run_id } }),
  );
  state.worktree = root;
  const legacy = canTransition(state, "COMPLETED", { worktree: root });
  assert.equal(legacy.ok, false);
  recordSubagentTimeout(root, {
    role: "reviewer",
    run_id: state.run_id,
    call_id: "review-1",
    unit: "unit-1",
  });
  state.current_unit = "unit-1";
  const opened = canTransition(state, "FINAL_VERIFYING", { worktree: root });
  assert.equal(opened.ok, false);
  assert.equal(opened.errors.some((error) => /illegal transition/.test(error)), false);
  assert.match(opened.errors.join("\n"), /nexus verify|sealed/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("H4 a forged or stale marker cannot delete a repository with extra commits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-forged-baseline-"));
  const { env, globalConfig } = isolatedEnv();
  try {
    assert.equal(git(root, ["init"], env).status, 0);
    git(root, ["config", "user.name", "Existing"], env);
    git(root, ["config", "user.email", "existing@example.test"], env);
    fs.writeFileSync(path.join(root, "app.js"), "export const app = 1;\n");
    git(root, ["add", "app.js"], env);
    git(root, ["commit", "-m", "one"], env);
    const rootCommit = git(root, ["rev-parse", "HEAD"], env).stdout.trim();
    fs.writeFileSync(path.join(root, "app.js"), "export const app = 2;\n");
    git(root, ["add", "app.js"], env);
    git(root, ["commit", "-m", "two"], env);
    fs.mkdirSync(path.join(root, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".opencode", "private-baseline.json"),
      JSON.stringify({
        created: true,
        existed_before: false,
        method: "git",
        commit: rootCommit,
        worktree: root,
        run_id: "forged",
      }),
    );
    const stat = fs.lstatSync(path.join(root, ".git"));
    const markerDir = path.join(root, ".opencode", "runs", "forged");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, "private-baseline.json"),
      JSON.stringify({
        created: true,
        existed_before: false,
        method: "git",
        run_id: "forged",
        commit: rootCommit,
        worktree: root,
        git_dir: { ino: stat.ino, dev: stat.dev, ctimeMs: stat.ctimeMs },
      }),
    );
    const cleaned = cleanupPrivateBaseline(root, { env, runId: "forged" });
    assert.equal(cleaned.removed, false);
    assert.notEqual(cleaned.reason, "removed-private-baseline");
    assert.equal(fs.existsSync(path.join(root, ".git")), true);
    assert.equal(git(root, ["rev-list", "--count", "HEAD"], env).stdout.trim(), "2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(globalConfig, { force: true });
  }
});

test("M1 cleanup refuses while an extra branch exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-branch-baseline-"));
  const { env, globalConfig } = isolatedEnv();
  try {
    const created = ensurePrivateBaseline(root, { env, runId: "branched" });
    assert.equal(created.ok, true, created.message);
    assert.equal(git(root, ["checkout", "-b", "feature"], env).status, 0);
    const cleaned = cleanupPrivateBaseline(root, { env, runId: "branched", fastPathMode: "standard" });
    assert.equal(cleaned.removed, false);
    assert.equal(cleaned.reason, "extra-refs");
    assert.equal(fs.existsSync(path.join(root, ".git")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(globalConfig, { force: true });
  }
});

test("M2 a failing global hook does not abort the private baseline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hooks-"));
  const { env, globalConfig } = isolatedEnv();
  const hooks = path.join(root, "bad-hooks");
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
  fs.chmodSync(path.join(hooks, "pre-commit"), 0o755);
  // Git config treats backslashes as escapes, so a raw Windows path is a bad line.
  const hooksForGit = hooks.replace(/\\/g, "/");
  fs.appendFileSync(globalConfig, `[core]\n\thooksPath = ${hooksForGit}\n`);
  try {
    fs.writeFileSync(path.join(root, "app.js"), "export const app = 1;\n");
    const created = ensurePrivateBaseline(root, { env, runId: "hooks" });
    assert.equal(created.ok, true, created.message);
    assert.equal(git(root, ["log", "-1", "--format=%s"], env).stdout.trim(), "nexus-baseline");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(globalConfig, { force: true });
  }
});

test("M3 large files and heavy directories are not committed into the baseline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-large-"));
  const { env, globalConfig } = isolatedEnv();
  try {
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "pkg.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(root, "blob.csv"), "x".repeat(80));
    fs.writeFileSync(path.join(root, "keep.js"), "export const keep = 1;\n");
    const created = ensurePrivateBaseline(root, { env, runId: "large", maxFileBytes: 40 });
    assert.equal(created.ok, true, created.message);
    assert.ok(created.skipped.includes("blob.csv"));
    const files = git(root, ["ls-files"], env).stdout;
    assert.match(files, /keep\.js/);
    assert.doesNotMatch(files, /blob\.csv/);
    assert.doesNotMatch(files, /node_modules/);
    assert.doesNotMatch(files, /\.opencode/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(globalConfig, { force: true });
  }
});

test("M4 parallel tasks abort the child that belongs to the timed-out call", async () => {
  const aborted = [];
  const timers = new Map();
  const watchdog = createSubagentWatchdog({
    budgets: { implementer: 10 },
    schedule(fn) {
      const id = timers.size + 1;
      timers.set(id, fn);
      return id;
    },
    cancel() {},
    now: () => 5,
    abortChild(sessionID) {
      aborted.push(sessionID);
      return Promise.resolve({ aborted: true });
    },
    onTimeout() {},
  });
  watchdog.before({ tool: "task", callID: "c1", sessionID: "parent" }, { args: { agent: "implementer" } });
  watchdog.before({ tool: "task", callID: "c2", sessionID: "parent" }, { args: { agent: "implementer" } });
  watchdog.noteChildSession("parent", "childA");
  watchdog.noteChildSession("parent", "childB");
  timers.get(1)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(aborted, ["childA"]);
});

test("M5 a timeout on unit-1 does not exhaust unit-2", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-unit-timeout-"));
  recordSubagentTimeout(root, {
    role: "implementer",
    run_id: "multi",
    call_id: "u1",
    unit: "unit-1",
  });
  recordSubagentTimeout(root, {
    role: "implementer",
    run_id: "multi",
    call_id: "u1-again",
    unit: "unit-1",
  });
  const second = recordSubagentTimeout(root, {
    role: "implementer",
    run_id: "multi",
    call_id: "u2",
    unit: "unit-2",
  });
  assert.equal(second.record.attempts, 1);
  assert.equal(second.record.exhausted, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("M6 a content-hash baseline reports files that changed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hash-dirty-"));
  try {
    fs.writeFileSync(path.join(root, "app.js"), "export const app = 1;\n");
    const created = ensurePrivateBaseline(root, { gitBin: path.join(root, "missing-git"), runId: "hash" });
    assert.equal(created.method, "content-hash");
    const gitBin = path.join(root, "missing-git");
    const clean = inspectWorkspace(root, { runId: "hash", gitBin });
    assert.equal(clean.clean, true, JSON.stringify(clean));
    fs.writeFileSync(path.join(root, "app.js"), "export const app = 2;\n");
    const dirty = inspectWorkspace(root, { runId: "hash", gitBin });
    assert.equal(dirty.clean, false);
    assert.deepEqual(dirty.dirty_paths, ["app.js"]);
    assert.notEqual(dirty.workspace_digest, clean.workspace_digest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("M7 apply_patch and multiedit honor paths and the line cap", () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-patch-"));
  const direct = {
    fast_path: { mode: "direct", enabled: true, repo_history: false, test_suite: false },
  };
  const patch = assessToolEdit({
    agent: "orchestrator",
    worktree,
    input: { tool: "apply_patch" },
    args: {
      patchText: "*** Begin Patch\n*** Update File: .opencode/plans/PLAN.md\n@@\n-old\n+new\n*** End Patch\n",
    },
    runState: direct,
  });
  assert.equal(patch.ok, true, patch.reason);
  const huge = assessToolEdit({
    agent: "orchestrator",
    worktree,
    input: { tool: "multiedit" },
    args: {
      edits: [
        {
          filePath: "src/app.js",
          oldString: "a",
          newString: Array.from({ length: 100 }, () => "line").join("\n"),
        },
      ],
    },
    runState: direct,
  });
  assert.equal(huge.ok, false);
  assert.match(huge.reason, /20 lines/);
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("M8 budgets and review rounds come from config, and two failures request review", () => {
  const budgets = loadRoleBudgets({
    implementer: { budget_ms: 1234 },
    reviewer: { budget_ms: 5678 },
  });
  assert.equal(budgets.implementer, 1234);
  assert.equal(budgets.reviewer, 5678);
  assert.equal(budgets["plan-advisor"], 5 * 60 * 1000);
  assert.equal(resolveMaxReviewRounds({ max_review_rounds: null }, {}, { NEXUS_MAX_REVIEW_ROUNDS: "" }), 1);
  let state = {
    fast_path: { mode: "direct", enabled: true, check_failures: 0 },
  };
  state = noteDirectVerification(state, { failed: true });
  state = noteDirectVerification(state, { failed: true, risk: "LOW" });
  assert.equal(state.fast_path.check_failures, 2);
  assert.equal(directReviewRequired(state), true);
});

test("M9 empty and null review-round settings stay at the default", () => {
  assert.equal(resolveMaxReviewRounds({ max_review_rounds: "" }), 1);
  assert.equal(resolveMaxReviewRounds({ max_review_rounds: null }), 1);
  assert.equal(resolveMaxReviewRounds({}, {}, { NEXUS_MAX_REVIEW_ROUNDS: "" }), 1);
});

test("H2 direct IMPLEMENTING refuses an oversized file list", () => {
  const state = {
    state: "BRAINSTORMING",
    fast_path: { mode: "direct", enabled: true, repo_history: false, test_suite: false },
  };
  const errors = directImplementErrors(state, {
    allowed_files: ["a.js", "b.js", "c.js", "d.js", "e.js", "f.js"],
    session_plan: "Goal: x\nNon-goals: y\nFiles: many\nCheck: npm test\nStop: escalate",
    acceptance_criteria: ["works"],
  });
  assert.match(errors.join("\n"), /EVIDENCE_OF_SIZE/);
});

test("L4 question marks match one character and a trailing space-star is optional", () => {
  assert.equal(permissionPatternMatches("ls ?", "ls a"), true);
  assert.equal(permissionPatternMatches("ls ?", "ls ab"), false);
  assert.equal(permissionPatternMatches("ls *", "ls"), true);
  assert.equal(
    permissionPatternMatches("ls *", "LS -la", { platform: "darwin" }),
    true,
  );
});
