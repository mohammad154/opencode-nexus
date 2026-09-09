import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { analyzeImpact } from "../scripts/lib/impact/analyze.js";
import { loadCache } from "../scripts/lib/impact/symbols.js";
import {
  buildImportIndex,
} from "../scripts/lib/impact/imports.js";
import {
  getChangedFilesFromGit,
  isNexusRuntimePath,
} from "../scripts/lib/scope-lock.js";
import {
  discoverVerification,
  resolveVerificationTargets,
} from "../scripts/lib/verification/discover.js";
import { createVerificationProvider } from "../scripts/lib/providers/verification-provider.js";
import {
  normalizeAndValidateHandoff,
  createEmptyRunState,
} from "../scripts/lib/migrate-artifacts.js";
import { projectInit } from "../scripts/lib/project-init.js";
import { transition } from "../scripts/lib/state-machine.js";
import { goodImplementerHandoff } from "./helpers/gate-fixtures.js";

function initGitRepo(prefix = "nexus-workflow-hardening-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  return dir;
}

function commitAll(dir, message) {
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", message], { cwd: dir });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

test("impact filtering excludes runtime artifacts and invalidates legacy cache", () => {
  const dir = initGitRepo();
  try {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "app.js"), "export const app = 1;\n");
    const base = commitAll(dir, "base");

    fs.writeFileSync(path.join(dir, "src", "app.js"), "export const app = 2;\n");
    for (const rel of [
      ".venv/test.py",
      "venv/test.py",
      "__pycache__/test.pyc",
      ".cache/runtime.js",
      ".tmp/runtime.js",
      "dist/bundle.js",
      ".antigravity/file.json",
    ]) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "runtime artifact\n");
    }

    // Seed a pre-versioned cache entry. The first filtered index must reject it.
    const cacheDir = path.join(dir, ".opencode", "cache", "impact");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "symbols.json"),
      JSON.stringify({ ".venv/test.py": { hash: "old", symbols: {} } }),
    );

    const report = analyzeImpact(dir, { base: "HEAD" });
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.changed_files.map((entry) => entry.path),
      ["src/app.js"],
    );
    assert.ok(
      report.ignored_files.some((entry) => entry.path === ".venv/test.py"),
    );
    assert.ok(
      report.ignored_files.some((entry) => entry.path === ".antigravity/file.json"),
    );

    const index = buildImportIndex(dir);
    assert.equal(Object.keys(index.byFile).some((file) => file.includes(".venv")), false);
    assert.equal(Object.keys(index.byFile).some((file) => file.includes("dist/")), false);
    assert.equal(report.index_stats.cache_invalidated, true);
    const cache = loadCache(dir);
    assert.equal(cache.meta.cache_version, "2");
    assert.equal(Object.hasOwn(cache.symbols, ".venv/test.py"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scope lock ignores .antigravity runtime files", () => {
  const dir = initGitRepo();
  try {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "app.js"), "export const app = 1;\n");
    const base = commitAll(dir, "base");
    fs.writeFileSync(path.join(dir, "src", "app.js"), "export const app = 2;\n");
    fs.mkdirSync(path.join(dir, ".antigravity"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".antigravity", "file.json"), "{}\n");

    const changed = getChangedFilesFromGit(dir, { base_commit: base });
    assert.deepEqual(changed, ["src/app.js"]);
    assert.equal(isNexusRuntimePath(".antigravity/file.json"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verification target resolver skips ignored, binary, generated, and missing paths", () => {
  const dir = initGitRepo();
  try {
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tests", "good.test.js"), "test('ok',()=>{});\n");
    fs.writeFileSync(path.join(dir, "tests", "example.generated.js"), "generated\n");
    fs.writeFileSync(path.join(dir, "tests", "image.png"), Buffer.from([137, 80, 78, 71]));
    fs.mkdirSync(path.join(dir, ".cache"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".cache", "bad.test.js"), "bad\n");
    fs.mkdirSync(path.join(dir, ".venv"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".venv", "bad.pyc"), "bad\n");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }, null, 2),
    );

    const resolved = resolveVerificationTargets(dir, [
      "tests/good.test.js",
      "tests/example.generated.js",
      "tests/image.png",
      ".cache/bad.test.js",
      ".venv/bad.pyc",
      "tests/missing.test.js",
    ]);
    assert.deepEqual(resolved.targets, ["tests/good.test.js"]);
    assert.equal(resolved.ignored.length, 5);

    const plan = discoverVerification(dir, {
      related_tests: ["tests/good.test.js", ".cache/bad.test.js"],
    });
    assert.deepEqual(plan.related_tests, ["tests/good.test.js"]);
    assert.ok(plan.steps.some((step) => step.id === "related:tests/good.test.js"));
    assert.equal(plan.steps.some((step) => step.id.includes(".cache")), false);

    const provider = createVerificationProvider();
    const run = provider.run({
      worktree: dir,
      plan: {
        ecosystem: "node",
        steps: [
          {
            id: "bad-target",
            command: process.execPath,
            args: ["-e", "process.exit(23)"],
            kind: "targeted-test",
            target: "dist/bundle.js",
          },
          {
            id: "safe",
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            kind: "generic",
          },
        ],
      },
    });
    assert.equal(run.ok, true);
    assert.ok(run.results.some((result) => result.status === "SKIPPED"));
    assert.equal(run.results.some((result) => result.id === "bad-target"), false);
    assert.equal(run.results.find((result) => result.id === "safe").pass, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("current handoff accepts unit alias and object-form passed tests", () => {
  const handoff = goodImplementerHandoff({
    tests: { passed: true, commands: ["npm test"] },
    impact: { risk: "LOW", verified: true },
  });
  delete handoff.unit_or_task;
  delete handoff.blast;
  handoff.unit = "unit-1";
  const result = normalizeAndValidateHandoff("implementer", handoff);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.data.unit_or_task, "unit-1");
  assert.equal(result.data.tests.passed, true);
});

test("project initialization creates the versioned scope policy without overwriting it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-policy-init-"));
  try {
    const first = projectInit(dir, { pkgVersion: "test" });
    const policyPath = path.join(dir, ".opencode", "config", "scope-policy.json");
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    assert.equal(first.scope_policy_created, true);
    assert.ok(policy.allowed.includes("plan/**"));
    assert.ok(policy.ignored.includes(".antigravity/**"));

    fs.writeFileSync(policyPath, JSON.stringify({ custom: true }));
    const second = projectInit(dir, { pkgVersion: "test" });
    assert.equal(second.scope_policy_created, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(policyPath, "utf8")), { custom: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid current handoff is rejected before VERIFYING providers run", () => {
  const state = createEmptyRunState("preflight-run", {
    state: "IMPLEMENTING",
    current_unit: "unit-1",
    head_commit: "base111",
  });
  const invalid = goodImplementerHandoff({
    run_id: "preflight-run",
    unit_or_task: "unit-1",
    base_commit: "base111",
  });
  delete invalid.impact;
  delete invalid.blast;
  let impactCalls = 0;
  let verificationCalls = 0;
  const providers = {
    impactProvider: {
      analyze() {
        impactCalls += 1;
        return { ok: true };
      },
    },
    verificationProvider: {
      discover() {
        verificationCalls += 1;
        return { steps: [] };
      },
      run() {
        verificationCalls += 1;
        return { ok: true, results: [] };
      },
    },
  };

  const result = transition(
    state,
    "VERIFYING",
    { implementer_handoff: invalid },
    providers,
  );
  assert.equal(result.ok, false);
  assert.equal(result.state, state);
  assert.equal(result.block_code, "INVALID_IMPLEMENTER_HANDOFF");
  assert.ok(result.errors.some((error) => /handoff invalid/i.test(error)));
  assert.equal(impactCalls, 0);
  assert.equal(verificationCalls, 0);
});
