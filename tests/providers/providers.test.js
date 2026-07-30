import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createDefaultProviders,
  createEditValidator,
  createMetricsTelemetry,
  getAgentCallBudget,
  getBlastProvider,
  getGraphProvider,
} from "../../scripts/lib/providers.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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

test("unsupported graph and blast modes are explicit instead of Lite fallbacks", () => {
  for (const mode of ["enhanced", "ide"]) {
    const graph = getGraphProvider(mode);
    assert.equal(graph.mode, mode);
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

  assert.equal(getGraphProvider("lite").supported, true);
  assert.equal(getBlastProvider("lite").supported, true);
});

test("Lite blast reports label incomplete placeholder fields", () => {
  const result = getBlastProvider("lite").analyze({
    report: {
      risk: "LOW",
      provider_validated: true,
      artifact_digest: "sha256:test-fixture",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.report.analysis_complete, false);
  assert.equal(result.report.analysis_quality, "lite-heuristic");
  assert.ok(result.report.placeholder_fields.includes("dimensions"));
});

test("Lite blast ignores unsealed inline trusted reports", () => {
  const result = getBlastProvider("lite").analyze({
    report: { risk: "LOW", trusted: true },
    worktree: tempDir("nexus-blast-ignore-"),
  });
  // Without a sealed report or on-disk artifact, analyze falls through to the script
  // and should not treat the fabricated trusted label as authoritative.
  assert.notEqual(result.report?.trusted, true);
});

test("default providers expose deterministic edit validation and metrics", () => {
  const providers = createDefaultProviders();
  assert.equal(providers.editValidator.mode, "deterministic");
  assert.equal(providers.editValidator.capability, "scope-and-obvious-safety");
  assert.equal(providers.telemetry.mode, "jsonl");
});

test("default providers preserve the resolved run context in call budgets", () => {
  const worktree = tempDir("nexus-run-context-");
  const providers = createDefaultProviders({
    worktree,
    profile: "strict",
    changeClass: "public-api",
    executionMode: "delegated",
    units: 2,
  });

  assert.deepEqual(providers.telemetry.getBudget(), {
    profile: "strict",
    change_class: "public-api",
    execution_mode: "delegated",
    units: 2,
    category: "dual",
    max_calls: 6,
    derived_max_calls: 6,
    source: "workflow-profile-defaults",
    used_calls: 0,
    remaining_calls: 6,
  });
});

test("agent-call budgets mirror profile defaults and never allow an escalation", () => {
  for (const profile of ["fast", "balanced", "strict"]) {
    assert.equal(
      getAgentCallBudget({ profile, changeClass: "documentation" }).max_calls,
      1,
    );
    assert.equal(
      getAgentCallBudget({ profile, executionMode: "direct" }).max_calls,
      1,
    );
  }
  assert.equal(getAgentCallBudget({ profile: "balanced", units: 2 }).max_calls, 4);
  assert.equal(getAgentCallBudget({ profile: "strict" }).max_calls, 3);
  assert.equal(
    getAgentCallBudget({ profile: "balanced", changeClass: "public-api" }).max_calls,
    3,
  );
  assert.equal(
    getAgentCallBudget({ profile: "strict", maxCalls: 99 }).max_calls,
    3,
  );
  assert.equal(
    getAgentCallBudget({ profile: "fast", maxCalls: 1 }).max_calls,
    1,
  );
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
    profile: "balanced",
    units: 1,
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
  assert.deepEqual(telemetry.getBudget(), {
    profile: "balanced",
    change_class: "small-feature-with-tests",
    execution_mode: "delegated",
    units: 1,
    category: "normal",
    max_calls: 2,
    derived_max_calls: 2,
    source: "workflow-profile-defaults",
    used_calls: 2,
    remaining_calls: 0,
  });
  const lines = fs.readFileSync(metricsPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.filter((line) => line.event === "agent_call").length, 2);
  assert.equal(lines.filter((line) => line.failure_code === "AGENT_CALL_BUDGET_EXCEEDED").length, 1);
  assert.equal(telemetry.getTotals().call_count, 2);
  assert.equal(telemetry.getTotals().failures, 1);
});

test("Lite graph provider rejects stale cache metadata", () => {
  const worktree = tempDir("nexus-graph-trust-");
  const knowledge = path.join(worktree, ".opencode", "knowledge");
  fs.mkdirSync(knowledge, { recursive: true });
  fs.writeFileSync(path.join(worktree, "index.js"), "export const value = 1;\n");
  fs.writeFileSync(
    path.join(knowledge, "graph.json"),
    JSON.stringify({
      generator_version: "1.0",
      extractor_quality: "CONSERVATIVE",
      nodes: [],
      edges: [],
    }),
  );

  const result = getGraphProvider("lite").build({ worktree });
  assert.equal(result.ok, false);
  assert.equal(result.cache_hit, false);
  assert.equal(result.quality, "UNKNOWN");
  assert.equal(result.provider_quality, "unknown");
  assert.equal(result.stale, true);
  assert.ok(result.trust_issues.length > 0);
});

test("Lite graph provider accepts fresh conservative snapshots as untrusted", () => {
  const worktree = tempDir("nexus-graph-conservative-");
  const knowledge = path.join(worktree, ".opencode", "knowledge");
  fs.mkdirSync(knowledge, { recursive: true });
  const source = "export const value = 1;\n";
  fs.writeFileSync(path.join(worktree, "index.js"), source);
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  execFileSync("git", ["config", "user.email", "nexus@example.test"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "Nexus Test"], { cwd: worktree });
  execFileSync("git", ["add", "index.js"], { cwd: worktree });
  execFileSync(
    "git",
    ["-c", "user.email=nexus@example.test", "-c", "user.name=Nexus Test", "commit", "-qm", "fixture"],
    { cwd: worktree },
  );

  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  const fileHash = digest(Buffer.from(source));
  const sourceFingerprint = digest(`index.js\t${fileHash}`);
  const workingTreeFingerprint = digest(JSON.stringify({
    head_commit: head,
    source_fingerprint: sourceFingerprint,
    status: [],
  }));
  const graph = {
    version: 2,
    root: worktree,
    output_dir: ".opencode/knowledge",
    generator_version: "3.0",
    source_fingerprint: sourceFingerprint,
    extractor_quality: "CONSERVATIVE",
    extractor: {
      name: "comment-aware-lexical",
      version: "3.0",
      quality: "CONSERVATIVE",
    },
    freshness: {
      head_commit: head,
      generator_version: "3.0",
      source_fingerprint: sourceFingerprint,
      working_tree_fingerprint: workingTreeFingerprint,
    },
    nodes: [{ id: "index.js", path: "index.js", file_hash: fileHash }],
    edges: [],
  };
  fs.writeFileSync(path.join(knowledge, "graph.json"), JSON.stringify(graph));

  const result = getGraphProvider("lite").build({ worktree });
  assert.equal(result.ok, true);
  assert.equal(result.cache_hit, true);
  assert.equal(result.quality, "CONSERVATIVE");
  assert.equal(result.trusted, false);
  assert.equal(result.stale, false);
  assert.equal(result.confidence, 0.5);
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
