/**
 * Evidence identity (plan §4) and Phase 0 runtime instrumentation.
 *
 * Identity is the precondition for every reuse decision in the runtime
 * optimization work, so these tests pin both the positive matching behavior and
 * the fail-closed behavior when a component cannot be measured.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEPENDENCY_FILES,
  IMPACT_ANALYZER_VERSION,
  dependencyDigest,
  environmentFingerprint,
  impactIdentity,
  isReusableVerificationResult,
  projectProfileIdentity,
  stepArgv,
  stepIdentity,
  targetSetDigest,
  verificationIdentity,
  verificationIdentityContext,
} from "../scripts/lib/evidence-identity.js";
import { createMetricsTelemetry, createNoopTelemetry } from "../scripts/lib/providers.js";

function tempDir(prefix = "nexus-identity-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const BASE = Object.freeze({
  head: "a".repeat(40),
  workspace_digest: "sha256:workspace",
  config_digest: "sha256:config",
  argv: ["npm", "test"],
  policy_digest: "sha256:policy",
  dependency_digest: "sha256:deps",
  environment_identity: "sha256:env",
});

test("verification identity is stable and order-independent in its inputs", () => {
  const first = verificationIdentity(BASE);
  const second = verificationIdentity({
    environment_identity: BASE.environment_identity,
    dependency_digest: BASE.dependency_digest,
    policy_digest: BASE.policy_digest,
    argv: ["npm", "test"],
    config_digest: BASE.config_digest,
    workspace_digest: BASE.workspace_digest,
    head: BASE.head,
  });
  assert.equal(first, second);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
});

test("every identity component changes the verification identity", () => {
  const baseline = verificationIdentity(BASE);
  const mutations = {
    head: "b".repeat(40),
    workspace_digest: "sha256:other-workspace",
    config_digest: "sha256:other-config",
    policy_digest: "sha256:other-policy",
    dependency_digest: "sha256:other-deps",
    environment_identity: "sha256:other-env",
  };
  for (const [key, value] of Object.entries(mutations)) {
    assert.notEqual(
      verificationIdentity({ ...BASE, [key]: value }),
      baseline,
      `${key} must change the identity`,
    );
  }
  assert.notEqual(verificationIdentity({ ...BASE, argv: ["npm", "test", "--", "x"] }), baseline);
});

test("an omitted optional component cannot collide with a supplied one", () => {
  const withPolicy = verificationIdentity(BASE);
  const withoutPolicy = verificationIdentity({ ...BASE, policy_digest: undefined });
  assert.notEqual(withPolicy, withoutPolicy);
});

test("verification identity fails closed on a missing required component", () => {
  for (const key of ["head", "workspace_digest", "config_digest"]) {
    assert.equal(
      verificationIdentity({ ...BASE, [key]: null }),
      null,
      `${key} is required`,
    );
  }
  assert.equal(verificationIdentity({ ...BASE, argv: [] , command: null }), null);
  assert.equal(verificationIdentity({ ...BASE, argv: ["npm", 7] }), null);
});

test("stepArgv rejects steps that cannot be identified", () => {
  assert.deepEqual(stepArgv({ command: "npm", args: ["test"] }), ["npm", "test"]);
  assert.deepEqual(stepArgv({ command: "npm" }), ["npm"]);
  assert.equal(stepArgv({ command: "" }), null);
  assert.equal(stepArgv({ command: "npm", args: [1] }), null);
});

test("target set digest ignores order and duplicates but not membership", () => {
  const a = targetSetDigest(["src/b.js", "src/a.js", "src/a.js"]);
  const b = targetSetDigest(["./src/a.js", "src/b.js"]);
  assert.equal(a, b);
  assert.notEqual(a, targetSetDigest(["src/a.js"]));
  assert.notEqual(a, targetSetDigest(["src/a.js", "src/b.js", "src/c.js"]));
});

test("impact identity requires HEAD and a measured workspace digest", () => {
  const complete = {
    head: BASE.head,
    workspace_digest: BASE.workspace_digest,
    base: "HEAD",
    phase: "pre",
    targets: ["src/a.js"],
    policy_digest: BASE.policy_digest,
  };
  const identity = impactIdentity(complete);
  assert.match(identity, /^sha256:[0-9a-f]{64}$/);
  assert.equal(impactIdentity({ ...complete, head: null }), null);
  assert.equal(impactIdentity({ ...complete, workspace_digest: null }), null);
  assert.notEqual(impactIdentity({ ...complete, targets: ["src/b.js"] }), identity);
  assert.notEqual(impactIdentity({ ...complete, phase: "post" }), identity);
  assert.notEqual(impactIdentity({ ...complete, base: "main" }), identity);
  assert.notEqual(
    impactIdentity({ ...complete, analyzer_version: "nexus-impact/999" }),
    identity,
  );
  assert.equal(IMPACT_ANALYZER_VERSION, "nexus-impact/1");
});

test("dependency digest tracks lockfile content and absence", () => {
  const root = tempDir("nexus-deps-");
  try {
    const empty = dependencyDigest(root);
    assert.match(empty, /^sha256:/);
    fs.writeFileSync(path.join(root, "package-lock.json"), '{"v":1}');
    const one = dependencyDigest(root);
    assert.notEqual(one, empty);
    fs.writeFileSync(path.join(root, "package-lock.json"), '{"v":2}');
    assert.notEqual(dependencyDigest(root), one);
    assert.equal(dependencyDigest(null), null);
    assert.ok(DEPENDENCY_FILES.includes("package-lock.json"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dependency digest fails closed when a lockfile is not a regular file", () => {
  const root = tempDir("nexus-deps-dir-");
  try {
    fs.mkdirSync(path.join(root, "package-lock.json"));
    assert.equal(dependencyDigest(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("environment fingerprint separates toolchains", () => {
  const a = environmentFingerprint({ version: "v20.0.0", platform: "linux", arch: "x64" });
  const b = environmentFingerprint({ version: "v22.0.0", platform: "linux", arch: "x64" });
  assert.notEqual(a, b);
  assert.equal(
    a,
    environmentFingerprint({ version: "v20.0.0", platform: "linux", arch: "x64" }),
  );
});

test("project profile identity reflects recon sources", () => {
  const root = tempDir("nexus-profile-");
  try {
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"x"}');
    const files = ["package.json", "AGENTS.md"];
    const first = projectProfileIdentity(root, files);
    assert.match(first, /^sha256:/);
    // Adding a previously absent source must invalidate the profile.
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# agents\n");
    assert.notEqual(projectProfileIdentity(root, files), first);
    assert.equal(projectProfileIdentity(root, []), null);
    assert.equal(projectProfileIdentity(null, files), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("identity context resolves once and drives per-step identities", () => {
  const root = tempDir("nexus-ctx-");
  try {
    const context = verificationIdentityContext({
      head: BASE.head,
      workspaceDigest: BASE.workspace_digest,
      configDigest: BASE.config_digest,
      policyDigest: BASE.policy_digest,
      worktree: root,
    });
    assert.equal(context.head, BASE.head);
    assert.ok(context.environment_identity);
    const lint = stepIdentity(context, { command: "npm", args: ["run", "lint"] });
    const tests = stepIdentity(context, { command: "npm", args: ["test"] });
    assert.notEqual(lint, tests);
    assert.equal(stepIdentity(context, { command: "" }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only a passing, identity-matched result is reusable", () => {
  const identity = verificationIdentity(BASE);
  const argv = ["npm", "test"];
  const passing = { pass: true, status: "PASSED", identity, argv };
  assert.equal(isReusableVerificationResult(passing, { identity, argv }), true);

  assert.equal(
    isReusableVerificationResult({ ...passing, pass: false, status: "FAILED" }, { identity, argv }),
    false,
    "a failure is never reusable",
  );
  assert.equal(
    isReusableVerificationResult({ ...passing, timed_out: true }, { identity, argv }),
    false,
    "a timeout is never reusable",
  );
  for (const status of ["UNAVAILABLE", "SKIPPED"]) {
    assert.equal(
      isReusableVerificationResult({ ...passing, status }, { identity, argv }),
      false,
      `${status} is never reusable`,
    );
  }
  assert.equal(
    isReusableVerificationResult(passing, { identity: "sha256:other", argv }),
    false,
  );
  assert.equal(
    isReusableVerificationResult(passing, { identity, argv: ["npm", "run", "lint"] }),
    false,
    "argv must match exactly",
  );
  assert.equal(isReusableVerificationResult(passing, { identity: null, argv }), false);
  assert.equal(isReusableVerificationResult(null, { identity, argv }), false);
});

test("telemetry reports a repeated command for the same identity as duplicate work", () => {
  const telemetry = createMetricsTelemetry({ enabled: false });
  const identity = verificationIdentity(BASE);

  const first = telemetry.recordVerificationCommand({
    run_id: "dup-run",
    step: "test",
    command: "npm test",
    identity,
  });
  assert.equal(first.duplicate, false);

  const second = telemetry.recordVerificationCommand({
    run_id: "dup-run",
    step: "test",
    command: "npm test",
    identity,
  });
  assert.equal(second.duplicate, true, "same identity executed twice is duplicate work");

  const reused = telemetry.recordVerificationCommand({
    run_id: "dup-run",
    step: "test",
    command: "npm test",
    identity,
    reused: true,
  });
  assert.equal(reused.duplicate, false, "a reuse is not duplicate work");

  const diagnostics = telemetry.getDuplicateWork();
  assert.equal(diagnostics.duplicate_commands, 1);
  assert.equal(diagnostics.verification_commands, 2);
  assert.equal(diagnostics.verification_reuse_count, 1);
});

test("telemetry never treats unidentified commands as matching each other", () => {
  const telemetry = createMetricsTelemetry({ enabled: false });
  telemetry.recordVerificationCommand({ run_id: "r", step: "test", command: "npm test" });
  const second = telemetry.recordVerificationCommand({
    run_id: "r",
    step: "test",
    command: "npm test",
  });
  assert.equal(second.duplicate, false, "no identity means no provable duplication");
  assert.equal(telemetry.getDuplicateWork().duplicate_commands, 0);
});

test("telemetry reports repeated impact analysis for one identity as duplicate work", () => {
  const telemetry = createMetricsTelemetry({ enabled: false });
  const identity = impactIdentity({
    head: BASE.head,
    workspace_digest: BASE.workspace_digest,
    targets: ["src/a.js"],
  });
  assert.equal(
    telemetry.recordImpactAnalysis({ run_id: "r", phase: "pre", identity }).duplicate,
    false,
  );
  assert.equal(
    telemetry.recordImpactAnalysis({ run_id: "r", phase: "pre", identity }).duplicate,
    true,
  );
  assert.equal(
    telemetry.recordImpactAnalysis({ run_id: "r", phase: "pre", identity, cache_hit: true })
      .duplicate,
    false,
  );
  const diagnostics = telemetry.getDuplicateWork();
  assert.equal(diagnostics.duplicate_impact_queries, 1);
  assert.equal(diagnostics.impact_calls, 2);
  assert.equal(diagnostics.impact_cache_hits, 1);
});

test("phase durations are recorded separately from step durations", () => {
  const telemetry = createMetricsTelemetry({ enabled: false });
  telemetry.recordStep({ run_id: "r", step: "implement", duration_ms: 40 });
  telemetry.recordPhase({ run_id: "r", phase: "planning", duration_ms: 500 });
  telemetry.recordPhase({
    run_id: "r",
    phase: "verification",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:00:01.000Z",
  });

  const summary = telemetry.getRuntimeSummary();
  assert.equal(summary.step_duration_ms, 40, "phase wall time must not double count steps");
  assert.deepEqual(summary.phase_durations_ms, { planning: 500, verification: 1000 });
  assert.equal(telemetry.getTotals().duration_ms, 40);
});

test("runtime summary exposes agent-call counts per agent", () => {
  const telemetry = createMetricsTelemetry({ enabled: false, units: 2 });
  telemetry.recordCall({ run_id: "r", agent: "implementer" });
  telemetry.recordCall({ run_id: "r", agent: "reviewer" });
  telemetry.recordCall({ run_id: "r", agent: "implementer" });

  const summary = telemetry.getRuntimeSummary();
  assert.deepEqual(summary.agent_calls, { implementer: 2, reviewer: 1 });
  assert.equal(summary.agent_call_count, 3);
});

test("metric sink still drops unknown fields after the whitelist expansion", () => {
  const worktree = tempDir("nexus-metric-sink-");
  try {
    const metricsPath = path.join(worktree, "metrics.jsonl");
    const telemetry = createMetricsTelemetry({ worktree, metricsPath });
    telemetry.recordVerificationCommand({
      run_id: "sink-run",
      step: "test",
      command: "npm test",
      identity: "sha256:abc",
      prompt: "secret-prompt",
      stdout_tail: "secret-output",
    });
    const raw = fs.readFileSync(metricsPath, "utf8");
    assert.equal(raw.includes("secret"), false);
    const event = JSON.parse(raw.trim());
    assert.equal(event.event, "verification_command");
    assert.equal(event.identity, "sha256:abc");
    assert.equal(event.duplicate, false);
    assert.equal(Object.hasOwn(event, "prompt"), false);
    assert.equal(Object.hasOwn(event, "stdout_tail"), false);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("noop telemetry supports the diagnostic surface without recording", () => {
  const telemetry = createNoopTelemetry();
  assert.equal(telemetry.recordVerificationCommand({ identity: "x" }).recorded, false);
  assert.equal(telemetry.recordImpactAnalysis({ identity: "x" }).recorded, false);
  assert.equal(telemetry.recordPhase({ phase: "planning" }).recorded, false);
  assert.equal(telemetry.getDuplicateWork().duplicate_commands, 0);
});
