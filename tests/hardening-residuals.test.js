import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertTransitionScopeLock,
  getChangedFilesFromGit,
  isNexusRuntimePath,
} from "../scripts/lib/scope-lock.js";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import { transition, canTransition } from "../scripts/lib/state-machine.js";
import { createVerificationProvider } from "../scripts/lib/providers/verification-provider.js";
import { discoverVerification } from "../scripts/lib/verification/discover.js";
import {
  goodImplementerHandoff,
  sealedVerification,
  sealedImpact,
  mockTrustProviders,
} from "./helpers/gate-fixtures.js";

test("missing allowed_files fails closed at VERIFYING (no skip)", () => {
  const r = assertTransitionScopeLock({
    state: { state: "IMPLEMENTING" },
    ctx: {},
    handoffData: { files_changed: ["evil.js"] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "SCOPE_UNBOUND");
  assert.equal(r.skipped, undefined);
});

test("handoff files_changed cannot bypass scope when worktree git evidence exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-scope-bypass-"));
  try {
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.js"), "1\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "base"], { cwd: dir });
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    fs.writeFileSync(path.join(dir, "src", "a.js"), "2\n");
    fs.writeFileSync(path.join(dir, "src", "evil.js"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "impl"], { cwd: dir });
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

    const r = assertTransitionScopeLock({
      state: {
        allowed_files: ["src/a.js"],
        head_commit: base,
        worktree: dir,
      },
      ctx: { worktree: dir },
      handoffData: {
        commit: head,
        base_commit: base,
        // Lie: claim only a.js changed
        files_changed: ["src/a.js"],
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "SCOPE_EXPANSION_REQUIRED");
    assert.ok(r.extras.includes("src/evil.js"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getChangedFilesFromGit ignores .opencode runtime artifacts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-scope-runtime-"));
  try {
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.js"), "1\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "base"], { cwd: dir });
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    fs.writeFileSync(path.join(dir, "src", "a.js"), "2\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "impl"], { cwd: dir });
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    fs.mkdirSync(path.join(dir, ".opencode", "runs", "r1"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".opencode", "runs", "r1", "state.json"), "{}\n");

    const changed = getChangedFilesFromGit(dir, {
      base_commit: base,
      implementer_commit: head,
    });
    assert.deepEqual(changed, ["src/a.js"]);
    assert.equal(isNexusRuntimePath(".opencode/runs/r1/state.json"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BLOCKED resume_state forge is ignored; only blocked_from is allowed", () => {
  const state = { ...createEmptyRunState("r-forge"), state: "VERIFYING" };
  const blocked = transition(state, "BLOCKED", {
    code: "SCOPE_EXPANSION_REQUIRED",
    reason: "x",
    resume_state: "REVIEWING",
  });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.state.resume_state, "VERIFYING");
  assert.equal(blocked.state.blocked_from, "VERIFYING");

  const forged = transition(blocked.state, "REVIEWING", {
    provider_verification: sealedVerification(),
  });
  assert.equal(forged.ok, false);
  assert.ok(forged.errors.some((e) => /illegal transition/i.test(e)));
});

test("state-machine discover path receives risk for ladder filtering", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-risk-wire-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        name: "x",
        scripts: { test: "node -e process.exit(0)", build: "echo build" },
      }),
    );
    const plan = discoverVerification(tmp, { risk: "LOW" });
    const ids = plan.steps.map((s) => s.id);
    assert.ok(ids.includes("test"));
    assert.ok(!ids.includes("build"));

    let sawRisk = false;
    const providers = {
      ...mockTrustProviders(),
      verificationProvider: {
        ...createVerificationProvider(),
        discover(ctx) {
          sawRisk = Boolean(ctx.risk || ctx.risk_tier);
          return discoverVerification(ctx.worktree || tmp, ctx);
        },
        run(ctx) {
          return createVerificationProvider().run({
            ...ctx,
            worktree: ctx.worktree || tmp,
          });
        },
      },
    };

    const state = {
      ...createEmptyRunState("risk-wire"),
      state: "IMPLEMENTING",
      worktree: tmp,
      allowed_files: ["package.json"],
      head_commit: "base",
      impact: { risk: "LOW", level: "LOW", related_tests: [] },
      current_unit: "u1",
      verification_policy: { exempt: false },
    };
    // Without git commits this may fail scope evidence; we only need revalidate path.
    // Use exempt to isolate risk wiring.
    state.verification_policy = { exempt: true };
    const r = transition(
      state,
      "VERIFYING",
      {
        worktree: tmp,
        implementer_handoff: goodImplementerHandoff({
          run_id: "risk-wire",
          unit_or_task: "u1",
          allowed_files: ["package.json"],
        }),
      },
      providers,
    );
    // Exempt path skips provider run — force non-exempt with sealed verification via canTransition
    assert.ok(r.ok || Array.isArray(r.errors));

    const state2 = {
      ...state,
      verification_policy: { exempt: false },
      provider_verification: sealedVerification(),
    };
    canTransition(state2, "VERIFYING", {
      worktree: tmp,
      provider_verification: sealedVerification(),
      post_impact: sealedImpact({ phase: "post", risk: "LOW" }),
      implementer_handoff: goodImplementerHandoff({
        run_id: "risk-wire",
        unit_or_task: "u1",
        allowed_files: ["package.json"],
        files_changed: [],
      }),
    });
    // Direct unit check: revalidate with providers
    const t = transition(
      {
        ...createEmptyRunState("risk-wire-2"),
        state: "IMPLEMENTING",
        worktree: tmp,
        allowed_files: ["package.json"],
        current_unit: "u1",
        impact: sealedImpact({ risk: "LOW", level: "LOW" }),
        verification_policy: { exempt: false },
      },
      "VERIFYING",
      {
        worktree: tmp,
        changed_files: [],
        implementer_handoff: goodImplementerHandoff({
          run_id: "risk-wire-2",
          unit_or_task: "u1",
          allowed_files: ["package.json"],
          files_changed: [],
        }),
      },
      providers,
    );
    assert.equal(sawRisk, true, `risk should be passed to discover; transition=${JSON.stringify(t.errors)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("agent call budget is enforced on VERIFYING after implementer charge", () => {
  const state = {
    ...createEmptyRunState("budget-run"),
    state: "IMPLEMENTING",
    profile: "strict",
    classification: { change_class: "documentation", review_level: "none" },
    review_level: "none",
    agent_calls_used: 100,
    allowed_files: ["src/app.js"],
    current_unit: "u1",
    verification_policy: { exempt: true },
  };
  const r = transition(
    state,
    "VERIFYING",
    {
      implementer_handoff: goodImplementerHandoff({
        run_id: "budget-run",
        unit_or_task: "u1",
      }),
    },
    mockTrustProviders(),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /AGENT_CALL_BUDGET_EXCEEDED/i.test(e)));
});
