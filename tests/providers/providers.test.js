import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createDefaultProviders,
  createEditValidator,
  createLessonsMemory,
  createMetricsTelemetry,
  getAgentCallBudget,
  getBlastProvider,
  getGraphProvider,
} from "../../scripts/lib/providers.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function diffFor(files, added = "const value = 1;") {
  return files
    .map(
      (file) => `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1 +1 @@
-const oldValue = 0;
+${added}`,
    )
    .join("\n");
}

test("unsupported graph and blast modes are explicit", () => {
  for (const mode of ["enhanced", "ide", "graphify"]) {
    const graph = getGraphProvider(mode);
    assert.equal(graph.mode, mode === "graphify" ? "graphify" : mode);
    assert.equal(graph.supported, false);
    assert.equal(graph.capability, "unsupported");
    assert.equal(graph.quality, "unavailable");
    assert.match(graph.error, /Unsupported graph provider mode/);
    assert.equal(graph.build().ok, false);

    const blast = getBlastProvider(mode);
    assert.equal(blast.mode, mode);
    assert.equal(blast.supported, false);
    assert.equal(blast.capability, "unsupported");
    assert.equal(blast.quality, "unavailable");
    assert.match(blast.error, /Unsupported blast provider mode/);
    assert.equal(blast.analyze().ok, false);
  }

  assert.equal(getGraphProvider("nexus-impact").supported, false);
  assert.equal(getBlastProvider("lite").supported, true);
  assert.equal(getBlastProvider("nexus-impact").supported, true);
  assert.equal(getBlastProvider("nexus-impact").mode, "nexus-impact");
});

test("default providers expose deterministic edit validation and metrics", () => {
  const providers = createDefaultProviders();
  assert.equal(providers.editValidator.mode, "deterministic");
  assert.equal(providers.editValidator.capability, "scope-and-obvious-safety");
  assert.equal(providers.telemetry.mode, "jsonl");
  assert.equal(providers.blastProvider.mode, "nexus-impact");
});

test("lessons memory reads opencode memory and reflected lessons paths", (t) => {
  const worktree = tempDir("nexus-memory-");
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(worktree, ".opencode", "memory"), { recursive: true });
  fs.mkdirSync(path.join(worktree, ".opencode", "reflections"), { recursive: true });
  fs.writeFileSync(
    path.join(worktree, ".opencode", "memory", "query_20260809.md"),
    "native memory entry",
  );
  fs.writeFileSync(
    path.join(worktree, ".opencode", "reflections", "LESSONS.md"),
    "reflected lesson",
  );

  const result = createLessonsMemory().retrieve(worktree);
  assert.equal(result.source, "opencode-memory");
  assert.equal(result.entries.length, 2);
  assert.ok(result.entries.some((entry) => entry.includes("native memory entry")));
  assert.ok(result.entries.some((entry) => entry.includes("reflected lesson")));
});

test("default providers preserve the resolved run context in call budgets", () => {
  const worktree = tempDir("nexus-run-context-");
  const providers = createDefaultProviders({
    worktree,
    units: 2,
  });

  assert.deepEqual(providers.telemetry.getBudget(), {
    profile: "default",
    workflow: "default",
    change_class: "task",
    execution_mode: "delegated",
    units: 2,
    category: "normal",
    max_calls: 6,
    derived_max_calls: 6,
    source: "v5-default-workflow",
    used_calls: 0,
    remaining_calls: 6,
  });
});

test("agent-call budgets use V5 fixed formula and never escalate past derived max", () => {
  assert.equal(getAgentCallBudget({ units: 1 }).max_calls, 4);
  assert.equal(getAgentCallBudget({ units: 2 }).max_calls, 6);
  assert.equal(getAgentCallBudget({ units: 1, maxCalls: 99 }).max_calls, 4);
  assert.equal(getAgentCallBudget({ units: 1, maxCalls: 1 }).max_calls, 1);
});

test("edit validator requires scope and validates an in-scope diff", () => {
  const validator = createEditValidator();
  const result = validator.validate({
    declared_scope: ["scripts/lib/providers.js"],
    diff: diffFor(["scripts/lib/providers.js"]),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.validated, true);
  assert.deepEqual(result.out_of_scope, []);
  assert.deepEqual(result.unsafe_findings, []);

  const missingScope = validator.validate({
    changed_files: ["scripts/lib/providers.js"],
    diff: diffFor(["scripts/lib/providers.js"]),
  });
  assert.equal(missingScope.ok, false);
  assert.equal(missingScope.validated, false);
  assert.match(missingScope.error, /declared scope/i);
});

test("edit validator rejects out-of-scope and obvious unsafe additions", () => {
  const validator = createEditValidator();
  const outOfScope = validator.validate({
    declared_scope: ["scripts/lib/providers.js"],
    diff: diffFor(["scripts/lib/providers.js", "package.json"]),
  });
  assert.equal(outOfScope.ok, false);
  assert.equal(outOfScope.validated, true);
  assert.deepEqual(outOfScope.out_of_scope, ["package.json"]);

  const unsafe = validator.validate({
    declared_scope: ["scripts/lib/providers.js"],
    diff: diffFor(["scripts/lib/providers.js"], "rm -rf /tmp/example"),
  });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.validated, true);
  assert.ok(
    unsafe.unsafe_findings.some((finding) =>
      finding.code === "destructive-shell-command",
    ),
  );

  const scopeOnly = validator.validate({
    declared_scope: ["scripts/lib/providers.js"],
    changed_files: ["scripts/lib/providers.js"],
  });
  assert.equal(scopeOnly.ok, false);
  assert.equal(scopeOnly.validated, false);
  assert.equal(scopeOnly.checks.safety, "not_available");
});

test("metrics JSONL records measurements without prompts or raw errors", () => {
  const worktree = tempDir("nexus-metrics-");
  const metricsPath = path.join(worktree, "metrics.jsonl");
  const telemetry = createMetricsTelemetry({ worktree, metricsPath });

  telemetry.recordStep({
    run_id: "metrics-run",
    step: "implement",
    duration_ms: 12,
    prompt: "do not write this secret prompt",
  });
  telemetry.recordCall({
    run_id: "metrics-run",
    provider: "host",
    tokens: { input: 10, output: 5 },
    cost_usd: 0.02,
    messages: [{ content: "secret message" }],
  });
  telemetry.recordCacheHit({ run_id: "metrics-run", step: "graph" });
  telemetry.recordFailure({
    run_id: "metrics-run",
    failure_code: "COMMAND_FAILED",
    error: "secret raw error",
  });

  const raw = fs.readFileSync(metricsPath, "utf8");
  assert.equal(raw.trim().split("\n").length, 4);
  assert.equal(raw.includes("secret"), false);
  const totals = telemetry.getTotals();
  assert.equal(totals.duration_ms, 12);
  assert.equal(totals.call_count, 1);
  assert.equal(totals.cache_hits, 1);
  assert.equal(totals.failures, 1);
  assert.deepEqual(totals.tokens, { input: 10, output: 5 });
  assert.equal(totals.cost_usd, 0.02);
});

test("metrics do not invent a USD value when the host supplies no pricing", () => {
  const telemetry = createMetricsTelemetry({ enabled: false });
  telemetry.recordCall({ run_id: "no-pricing", provider: "host" });
  assert.equal(Object.hasOwn(telemetry.getTotals(), "cost_usd"), false);
});

test("metrics enforce the hard agent-call budget and record rejected calls", () => {
  const worktree = tempDir("nexus-budget-");
  const metricsPath = path.join(worktree, "metrics.jsonl");
  const telemetry = createMetricsTelemetry({
    worktree,
    metricsPath,
    units: 1,
    maxCalls: 2,
  });

  assert.equal(telemetry.recordCall({ run_id: "budget-run", provider: "host" }).accepted, true);
  assert.equal(
    telemetry.recordCall({ run_id: "budget-run", provider: "host" }).accepted,
    true,
  );
  const rejected = telemetry.recordCall({ run_id: "budget-run", provider: "host" });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.budget_exceeded, true);
  assert.equal(rejected.failure_code, "AGENT_CALL_BUDGET_EXCEEDED");
  const budget = telemetry.getBudget();
  assert.equal(budget.max_calls, 2);
  assert.equal(budget.used_calls, 2);
  assert.equal(budget.remaining_calls, 0);
  assert.equal(budget.source, "v5-default-workflow");
  const lines = fs.readFileSync(metricsPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.filter((line) => line.event === "agent_call").length, 2);
  assert.equal(lines.filter((line) => line.failure_code === "AGENT_CALL_BUDGET_EXCEEDED").length, 1);
  assert.equal(telemetry.getTotals().call_count, 2);
  assert.equal(telemetry.getTotals().failures, 1);
});

test("default telemetry writes metrics for an initialized run", () => {
  const worktree = tempDir("nexus-run-metrics-");
  fs.mkdirSync(path.join(worktree, ".opencode", "runs", "run-1"), {
    recursive: true,
  });
  const providers = createDefaultProviders({ worktree });
  const result = providers.telemetry.recordCall({
    run_id: "run-1",
    provider: "host",
  });
  assert.equal(result.recorded, true);
  const metricsPath = path.join(
    worktree,
    ".opencode",
    "runs",
    "run-1",
    "metrics.jsonl",
  );
  assert.equal(fs.existsSync(metricsPath), true);
  assert.match(fs.readFileSync(metricsPath, "utf8"), /"event":"agent_call"/);
});

test("impact blast provider analyzes in a git worktree", (t) => {
  const worktree = tempDir("nexus-impact-blast-");
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  execFileSync("git", ["config", "user.email", "nexus@example.test"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "Nexus Test"], { cwd: worktree });
  fs.writeFileSync(path.join(worktree, "index.js"), "export const value = 1;\n");
  execFileSync("git", ["add", "index.js"], { cwd: worktree });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: worktree });

  const result = getBlastProvider("nexus-impact").analyze({ worktree });
  assert.equal(result.ok, true);
  assert.equal(result.report.provider, "nexus-impact");
  assert.match(result.path, /\.opencode\/impact\/latest\.json$/);
});
