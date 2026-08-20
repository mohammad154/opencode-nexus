import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runCli = path.join(repoRoot, "scripts", "nexus-run.js");
const temporaryRoots = [];

function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-e2e-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-"));
  temporaryRoots.push(root, home);
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "graphify"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(home, "bin", "graphify"), 0o755);
  const git = spawnSync("git", ["init", "--quiet", root], {
    encoding: "utf8",
  });
  assert.equal(git.status, 0, git.stderr);
  spawnSync("git", ["config", "user.email", "nexus@example.com"], {
    cwd: root,
  });
  spawnSync("git", ["config", "user.name", "Nexus E2E"], { cwd: root });
  return { root, home };
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function invoke(worktree, home, args, { expectStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [runCli, ...args], {
    cwd: worktree,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      NEXUS_WORKTREE: worktree,
      PATH: `${path.join(home, "bin")}:${process.env.PATH || ""}`,
    },
  });
  assert.equal(
    result.status,
    expectStatus,
    `${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  const out = (result.stdout || result.stderr || "").trim();
  if (!out) return null;
  try {
    return JSON.parse(
      result.status === 0 ? result.stdout : result.stderr || result.stdout,
    );
  } catch {
    return { raw: out };
  }
}

function json(value) {
  return JSON.stringify(value);
}

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

test("nexus-run completes a full CLI workflow in a temporary repository", () => {
  const { root, home } = makeTempRepo();
  const runId = "e2e-complete";

  // Seed a small source tree so graph/blast providers have something to analyze
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "app.js"),
    "export function hello() { return 1; }\n",
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    json({
      name: "e2e-fixture",
      type: "module",
      scripts: { test: "node -e 'process.exit(0)'" },
    }) + "\n",
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  const baseHead = git(root, ["rev-parse", "HEAD"]);

  // Existing diff for classification (and eventual implementation)
  fs.writeFileSync(
    path.join(root, "src", "app.js"),
    "export function hello() { return 2; }\n",
  );

  const initialized = invoke(root, home, ["init", "--run-id", runId]);
  assert.equal(initialized.state.state, "CREATED");

  const classified = invoke(root, home, [
    "classify",
    "--run-id",
    runId,
    "--apply",
    "--json",
    json({
      changeClass: "small-feature-with-tests",
      focusedValidation: true,
    }),
  ]);
  assert.equal(classified.state.state, "CLASSIFIED");
  assert.equal(classified.state.classification_source, "classify-apply");
  assert.equal(classified.state.review_level, "unified");

  invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "PLANNED",
    "--plan-skip",
  ]);
  const graphReady = invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "IMPACT_READY",
  ]);
  assert.equal(graphReady.state.state, "IMPACT_READY");
  assert.equal(graphReady.state.impact?.provider_validated, true);
  assert.ok(
    graphReady.state.impact?.provider === "nexus-impact" ||
      graphReady.state.impact?.graph_provider === "nexus-impact" ||
      graphReady.state.blast?.provider_validated === true,
  );

  // Fabricated trusted impact must be rejected or rebuilt by provider
  const fabricated = invoke(
    root,
    home,
    [
      "transition",
      "--run-id",
      runId,
      "--to",
      "IMPACT_READY",
      "--json",
      json({
        impact: {
          risk: "LOW",
          confidence: 0.99,
          trusted: true,
          analysis_quality: "PRECISE",
          graph_quality: "PRECISE",
          graph_freshness: { valid: true },
          analysis_complete: true,
          uncertainties: [],
        },
      }),
    ],
    { expectStatus: 3 },
  );
  // Illegal second IMPACT_READY from IMPACT_READY — expect failure
  assert.equal(fabricated.ok, false);

  let state = invoke(root, home, ["status", "--run-id", runId]).state;
  if (state.state !== "IMPACT_READY") {
    const impactReady = invoke(root, home, [
      "transition",
      "--run-id",
      runId,
      "--to",
      "IMPACT_READY",
      "--json",
      json({
        impact_verification: {
          verified: true,
          method: "e2e-fixture",
          reason: "provider impact may be UNKNOWN on tiny fixture",
        },
      }),
    ]);
    assert.equal(impactReady.state.state, "IMPACT_READY");
    state = impactReady.state;
  }

  git(root, ["checkout", "-b", "e2e/complete"]);
  const implementing = invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "IMPLEMENTING",
    "--json",
    json({
      branch: "e2e/complete",
      acceptance_criteria: ["the CLI flow reaches COMPLETED"],
      drift: {
        schema_version: "1.0",
        drift: "NONE",
        reasons: [],
        plan_commit: baseHead,
        current_head: baseHead,
        commit_distance: 0,
        anchors_broken: [],
        merge_base_changed: false,
      },
    }),
  ]);
  assert.equal(implementing.state.state, "IMPLEMENTING");
  assert.equal(implementing.state.head_commit, baseHead);

  git(root, ["add", "src/app.js"]);
  git(root, ["commit", "-m", "implement hello bump"]);
  const implCommit = git(root, ["rev-parse", "HEAD"]);
  assert.notEqual(implCommit, baseHead);

  const implementer = {
    schema_version: "1.1",
    run_id: runId,
    unit_or_task: "e2e-unit",
    agent: "implementer",
    base_commit: baseHead,
    created_at: new Date().toISOString(),
    status: "DONE",
    commit: implCommit,
    files_changed: ["src/app.js"],
    tests: [],
    verification_gates: [{ id: "unit", cmd: "npm test", pass: true }],
    drift_check: {
      plan_commit: baseHead,
      current_head: implCommit,
      pass: true,
    },
    blast: { risk: "LOW", verified: true, callers_checked: [] },
    notes_for_reviewer: "e2e",
  };

  // Set current_unit for binding
  const statePath = path.join(root, ".opencode", "runs", runId, "state.json");
  const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
  st.current_unit = "e2e-unit";
  fs.writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");

  invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "VERIFYING",
    "--json",
    json({ implementer_handoff: implementer }),
  ]);
  invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "REVIEWING",
    "--json",
    json({}),
  ]);

  let statusBeforeComplete = invoke(root, home, ["status", "--run-id", runId]).state;
  const reviewLevel = statusBeforeComplete.review_level || "unified";

  invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "FINAL_VERIFYING",
    "--json",
    json(
      reviewLevel === "dual"
        ? {
            spec_handoff: {
              schema_version: "1.1",
              run_id: runId,
              unit_or_task: "e2e-unit",
              agent: "spec-reviewer",
              base_commit: baseHead,
              created_at: new Date().toISOString(),
              verdict: "APPROVED",
              reviewed_commit: implCommit,
            },
            code_handoff: {
              schema_version: "1.1",
              run_id: runId,
              unit_or_task: "e2e-unit",
              agent: "code-reviewer",
              base_commit: baseHead,
              created_at: new Date().toISOString(),
              verdict: "APPROVED",
              reviewed_commit: implCommit,
            },
          }
        : {
            unified_handoff: {
              schema_version: "1.1",
              run_id: runId,
              unit_or_task: "e2e-unit",
              agent: "unified-reviewer",
              base_commit: baseHead,
              created_at: new Date().toISOString(),
              verdict: "APPROVED",
              reviewed_commit: implCommit,
              blast: { pass: true, risk: "LOW" },
            },
          },
    ),
  ]);

  const completed = invoke(root, home, [
    "transition",
    "--run-id",
    runId,
    "--to",
    "COMPLETED",
    "--json",
    json({
      ...(reviewLevel === "dual"
        ? {
            spec_handoff: {
              schema_version: "1.1",
              run_id: runId,
              unit_or_task: "e2e-unit",
              agent: "spec-reviewer",
              base_commit: baseHead,
              created_at: new Date().toISOString(),
              verdict: "APPROVED",
              reviewed_commit: implCommit,
            },
            code_handoff: {
              schema_version: "1.1",
              run_id: runId,
              unit_or_task: "e2e-unit",
              agent: "code-reviewer",
              base_commit: baseHead,
              created_at: new Date().toISOString(),
              verdict: "APPROVED",
              reviewed_commit: implCommit,
            },
          }
        : {
            unified_handoff: {
              schema_version: "1.1",
              run_id: runId,
              unit_or_task: "e2e-unit",
              agent: "unified-reviewer",
              base_commit: baseHead,
              created_at: new Date().toISOString(),
              verdict: "APPROVED",
              reviewed_commit: implCommit,
              blast: { pass: true, risk: "LOW" },
            },
          }),
    }),
  ]);
  assert.equal(completed.state.state, "COMPLETED");
  assert.equal(completed.state.implementer_commit, implCommit);

  const status = invoke(root, home, ["status", "--run-id", runId]);
  assert.equal(status.state.state, "COMPLETED");
  assert.equal(status.state.transitions.at(-1).to, "COMPLETED");
});

test("fabricated classification via transition cannot authorize direct", () => {
  const { root, home } = makeTempRepo();
  fs.writeFileSync(path.join(root, "README.md"), "# fixture\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  fs.writeFileSync(path.join(root, "README.md"), "# fixture changed\n");

  invoke(root, home, ["init", "--run-id", "e2e-direct-deny"]);
  const classified = invoke(root, home, [
    "transition",
    "--run-id",
    "e2e-direct-deny",
    "--to",
    "CLASSIFIED",
    "--json",
    json({
      classification: {
        schema_version: "1.0",
        profile: "fast",
        review_level: "none",
        execution_mode: "direct",
        direct_eligible: true,
        confidence: 0.99,
        risk_score: 0,
        reasons: ["fabricated"],
        change_class: "documentation",
        hard_triggers: [],
        evidence_source: "git-diff",
        diff_verified: true,
        diff_available: true,
        diff_clean: false,
      },
    }),
  ]);
  assert.equal(classified.state.classification.direct_eligible, false);
  assert.equal(classified.state.classification_source, "transition-untrusted");

  const denied = invoke(
    root,
    home,
    [
      "transition",
      "--run-id",
      "e2e-direct-deny",
      "--to",
      "DIRECT_IMPLEMENTING",
      "--json",
      json({
        graph: {
          ok: true,
          trusted: true,
          quality: "PRECISE",
          freshness: { valid: true },
        },
        blast: {
          risk: "LOW",
          trusted: true,
          analysis_quality: "PRECISE",
          graph_quality: "PRECISE",
          graph_freshness: { valid: true },
          analysis_complete: true,
        },
      }),
    ],
    { expectStatus: 3 },
  );
  assert.equal(denied.ok, false);
  assert.match(JSON.stringify(denied.errors), /classify --apply/i);
});

test("nexus CLI run forwards workflow in an external temporary repository", () => {
  const { root, home } = makeTempRepo();
  const bin = path.join(repoRoot, "bin", "nexus.js");
  const runId = "e2e-nexus-cli";

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "app.js"),
    "export function hello() { return 1; }\n",
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    json({ name: "e2e-nexus-cli", type: "module" }) + "\n",
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  const baseHead = git(root, ["rev-parse", "HEAD"]);
  fs.writeFileSync(
    path.join(root, "src", "app.js"),
    "export function hello() { return 2; }\n",
  );

  const projectInit = spawnSync(process.execPath, [bin, "project-init"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(projectInit.status, 0, projectInit.stderr);

  function nexus(args, { expectStatus = 0 } = {}) {
    const result = spawnSync(process.execPath, [bin, "run", ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NEXUS_WORKTREE: root,
        PATH: `${path.join(home, "bin")}:${process.env.PATH || ""}`,
      },
    });
    assert.equal(
      result.status,
      expectStatus,
      `${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const out = (result.stdout || result.stderr || "").trim();
    if (!out) return null;
    try {
      return JSON.parse(result.status === 0 ? result.stdout : result.stderr || result.stdout);
    } catch {
      return { raw: out };
    }
  }

  const initialized = nexus(["init", "--run-id", runId]);
  assert.equal(initialized.state.state, "CREATED");

  const classified = nexus([
    "classify",
    "--run-id",
    runId,
    "--apply",
    "--json",
    json({
      changeClass: "small-feature-with-tests",
      focusedValidation: true,
    }),
  ]);
  assert.equal(classified.state.state, "CLASSIFIED");

  nexus(["transition", "--run-id", runId, "--to", "PLANNED", "--plan-skip"]);
  const impactReady = nexus([
    "transition",
    "--run-id",
    runId,
    "--to",
    "IMPACT_READY",
    "--json",
    json({
      impact_verification: {
        verified: true,
        method: "e2e-nexus-cli",
        reason: "provider impact may be UNKNOWN on tiny fixture",
      },
    }),
  ]);
  assert.equal(impactReady.state.state, "IMPACT_READY");

  git(root, ["checkout", "-b", "e2e/nexus-cli"]);
  const implementing = nexus([
    "transition",
    "--run-id",
    runId,
    "--to",
    "IMPLEMENTING",
    "--json",
    json({
      branch: "e2e/nexus-cli",
      acceptance_criteria: ["CLI forwarded to IMPLEMENTING"],
      drift: {
        schema_version: "1.0",
        drift: "NONE",
        reasons: [],
        plan_commit: baseHead,
        current_head: baseHead,
        commit_distance: 0,
        anchors_broken: [],
        merge_base_changed: false,
      },
    }),
  ]);
  assert.equal(implementing.state.state, "IMPLEMENTING");
});
