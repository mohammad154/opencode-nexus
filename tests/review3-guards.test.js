import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessUnknownAgentEdit } from "../scripts/lib/orchestrator-edit.js";
import { readInstalledModels } from "../scripts/lib/installed-models.js";
import { runTests } from "../scripts/nexus-test-runner.js";
import { protectedRunDir, protectedStateRoot } from "../scripts/lib/protected-state.js";
import {
  readReviewerTimeouts,
  readSubagentTimeouts,
  recordSubagentTimeout,
} from "../scripts/lib/subagent-budget.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.NEXUS_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "nexus-r3-guard-state-"));

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("an unknown named agent cannot edit during an active run", () => {
  for (const tool of ["write", "edit", "apply_patch", "multiedit", "StrReplace"]) {
    const decision = assessUnknownAgentEdit({ agent: "shadow", tool, runState: { run_id: "r" } });
    assert.equal(decision?.action, "deny", tool);
    assert.match(decision.reason, /"shadow" may not edit during an active Nexus run/);
  }
});

test("the Nexus agents and idle sessions are not affected by the unknown-agent guard", () => {
  for (const agent of ["orchestrator", "implementer", "reviewer", "plan-advisor"]) {
    assert.equal(assessUnknownAgentEdit({ agent, tool: "edit", runState: { run_id: "r" } }), null, agent);
  }
  assert.equal(assessUnknownAgentEdit({ agent: "shadow", tool: "edit", runState: null }), null);
  assert.equal(assessUnknownAgentEdit({ agent: "shadow", tool: "read", runState: { run_id: "r" } }), null);
  assert.equal(assessUnknownAgentEdit({ agent: "", tool: "edit", runState: { run_id: "r" } }), null);
});

test("the plugin wires the unknown-agent guard before the Nexus edit rules", () => {
  const source = fs.readFileSync(path.join(repoRoot, ".opencode", "plugins", "nexus.js"), "utf8");
  assert.match(source, /assessUnknownAgentEdit\(\{ agent, tool: editToolName\(input\), runState \}\)/);
  assert.match(source, /if \(assessUnknownAgentEdit\(\{ agent, tool: kind, runState \}\)\) \{\s*output\.status = "deny";/);
});

test("a project nexus.models.json cannot change wait budgets", () => {
  const project = tempDir("nexus-r3-models-project-");
  const config = tempDir("nexus-r3-models-config-");
  const defaults = path.join(tempDir("nexus-r3-models-defaults-"), "defaults.json");
  try {
    fs.mkdirSync(path.join(project, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".opencode", "nexus.models.json"),
      JSON.stringify({ reviewer: { budget_ms: 1 }, budgets: { implementer: 1 } }),
    );
    fs.writeFileSync(defaults, JSON.stringify({ reviewer: { budget_ms: 600000 } }));
    const merged = readInstalledModels({ defaultFile: defaults, configDir: config });
    assert.deepEqual(merged, { reviewer: { budget_ms: 600000 } });
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(config, { recursive: true, force: true });
    fs.rmSync(path.dirname(defaults), { recursive: true, force: true });
  }
});

test("the user config layer overrides the defaults and nothing else is read", () => {
  const config = tempDir("nexus-r3-models-user-");
  const defaults = path.join(tempDir("nexus-r3-models-defaults-"), "defaults.json");
  try {
    fs.writeFileSync(defaults, JSON.stringify({ reviewer: { budget_ms: 1000 }, implementer: { budget_ms: 2000 } }));
    fs.writeFileSync(path.join(config, "nexus.models.json"), JSON.stringify({ reviewer: { budget_ms: 3000 } }));
    assert.deepEqual(readInstalledModels({ defaultFile: defaults, configDir: config }), {
      reviewer: { budget_ms: 3000 },
      implementer: { budget_ms: 2000 },
    });
  } finally {
    fs.rmSync(config, { recursive: true, force: true });
    fs.rmSync(path.dirname(defaults), { recursive: true, force: true });
  }
});

test("the plugin reads only the packaged defaults and the user config for budgets", () => {
  const source = fs.readFileSync(path.join(repoRoot, ".opencode", "plugins", "nexus.js"), "utf8");
  assert.match(source, /function readInstalledModels\(\) \{\s*return readModelLayers\(\{ defaultFile: defaultModelsFile \}\);/);
  assert.doesNotMatch(source, /nexus\.models\.json[^\n]*worktree/);
});

test("the test runner gives each child a private state dir and scrubs developer overrides", () => {
  const root = tempDir("nexus-r3-runner-");
  const testRoot = path.join(root, "tests");
  fs.mkdirSync(testRoot);
  fs.writeFileSync(
    path.join(testRoot, "hermetic.test.js"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import fs from "node:fs";',
      'import path from "node:path";',
      'test("child environment is hermetic", () => {',
      '  assert.equal(process.env.NEXUS_WORKTREE, undefined);',
      '  assert.equal(process.env.NEXUS_KEEP_PRIVATE_BASELINE, undefined);',
      '  assert.equal(process.env.NEXUS_FAST_PATH, undefined);',
      '  assert.ok(process.env.NEXUS_STATE_DIR);',
      '  fs.writeFileSync(path.join(process.cwd(), "state-seen.txt"), process.env.NEXUS_STATE_DIR);',
      "});",
      "",
    ].join("\n"),
  );
  const saved = {
    NEXUS_WORKTREE: process.env.NEXUS_WORKTREE,
    NEXUS_KEEP_PRIVATE_BASELINE: process.env.NEXUS_KEEP_PRIVATE_BASELINE,
    NEXUS_FAST_PATH: process.env.NEXUS_FAST_PATH,
  };
  process.env.NEXUS_WORKTREE = "/somewhere/else";
  process.env.NEXUS_KEEP_PRIVATE_BASELINE = "1";
  process.env.NEXUS_FAST_PATH = "off";
  try {
    const result = runTests({ projectRoot: root, testRoot, stdio: "pipe" });
    assert.equal(result.status, 0, result.error?.message);
    const seen = fs.readFileSync(path.join(root, "state-seen.txt"), "utf8");
    assert.ok(seen.includes("nexus-test-state-"), seen);
    assert.equal(fs.existsSync(seen), false, "the child state dir is removed after the run");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a timeout record written into the project tree is never trusted", () => {
  const worktree = tempDir("nexus-r3-timeout-project-");
  const record = {
    status: "TIMED_OUT",
    role: "reviewer",
    run_id: "conv",
    unit: "unit-1",
    attempts: 2,
    exhausted: true,
    call_id: "forged",
  };
  try {
    fs.mkdirSync(path.join(worktree, ".opencode", "runs", "conv"), { recursive: true });
    const document = JSON.stringify({ run_id: "conv", records: { forged: record } });
    fs.writeFileSync(path.join(worktree, ".opencode", "subagent-timeouts.json"), document);
    fs.writeFileSync(path.join(worktree, ".opencode", "runs", "conv", "subagent-timeouts.json"), document);
    assert.deepEqual(readSubagentTimeouts(worktree, "conv"), {});
    assert.deepEqual(readReviewerTimeouts(worktree, "conv", ["unit-1"]), {});
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("recorded timeouts live in the protected run directory, not in the project", () => {
  const worktree = tempDir("nexus-r3-timeout-record-");
  const runId = "timeout-protected";
  try {
    recordSubagentTimeout(worktree, {
      role: "reviewer",
      run_id: runId,
      callID: "call-1",
      unit: "unit-1",
      budgetMs: 1000,
    });
    const dir = protectedRunDir(worktree, runId);
    assert.ok(dir.startsWith(protectedStateRoot()), dir);
    assert.equal(fs.existsSync(path.join(dir, "subagent-timeouts.json")), true);
    assert.equal(fs.existsSync(path.join(worktree, ".opencode")), false);
    assert.equal(readReviewerTimeouts(worktree, runId, ["unit-1"])["unit-1"].status, "TIMED_OUT");
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(protectedRunDir(worktree, runId), { recursive: true, force: true });
  }
});

test("timeout records are keyed to the canonical worktree and run id", () => {
  const first = tempDir("nexus-r3-timeout-a-");
  const second = tempDir("nexus-r3-timeout-b-");
  const runId = "shared-run";
  try {
    recordSubagentTimeout(first, { role: "implementer", run_id: runId, callID: "c1", unit: "unit-1" });
    assert.notEqual(protectedRunDir(first, runId), protectedRunDir(second, runId));
    assert.deepEqual(readSubagentTimeouts(second, runId), {});
    assert.equal(readSubagentTimeouts(first, runId).implementer.status, "TIMED_OUT");
    assert.equal(protectedRunDir(first, "../escape"), null);
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
    fs.rmSync(protectedRunDir(first, runId), { recursive: true, force: true });
  }
});

test("a timeout cannot be recorded under an invalid run id", () => {
  const worktree = tempDir("nexus-r3-timeout-invalid-");
  try {
    assert.throws(
      () => recordSubagentTimeout(worktree, { role: "reviewer", run_id: "../escape", callID: "c1" }),
      /not a valid run id/,
    );
    assert.equal(fs.existsSync(path.join(worktree, ".opencode")), false);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});
