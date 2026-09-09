import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildTaskDag,
  detectCycle,
  scheduleParallel,
  readyTasks,
} from "../../scripts/lib/task-dag.js";
import { assertScopeLock } from "../../scripts/lib/scope-lock.js";
import {
  fixLoopDecision,
  canSelfApprove,
  unresolvedHighFindings,
} from "../../scripts/lib/review-protocol.js";
import { compareBaselines, verificationLadder } from "../../scripts/lib/verification/compare.js";
import {
  discoverVerification,
  filterVerificationPlan,
} from "../../scripts/lib/verification/discover.js";

test("task DAG rejects cycles", () => {
  const dag = buildTaskDag([
    { id: "a", depends_on: ["b"] },
    { id: "b", depends_on: ["a"] },
  ]);
  assert.ok(detectCycle(dag));
});

test("parallel scheduler respects deps and file conflicts", () => {
  const dag = buildTaskDag([
    { id: "a", files: ["a.js"] },
    { id: "b", depends_on: ["a"], files: ["b.js"] },
    { id: "c", files: ["c.js"] },
  ]);
  const plan = scheduleParallel(dag, { maxConcurrency: 2 });
  assert.equal(plan.ok, true);
  assert.ok(plan.waves[0].includes("a"));
  assert.ok(plan.waves[0].includes("c") || plan.waves.length >= 1);
  assert.ok(plan.waves.flat().includes("b"));
});

test("scope lock blocks extras", () => {
  const ok = assertScopeLock({
    allowed_files: ["src/a.js"],
    changed_files: ["src/a.js"],
  });
  assert.equal(ok.ok, true);
  const bad = assertScopeLock({
    allowed_files: ["src/a.js"],
    changed_files: ["src/a.js", "src/b.js"],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "SCOPE_EXPANSION_REQUIRED");
});

test("fix loop redispatches until cap", () => {
  const findings = [{ severity: "HIGH", id: "1", resolved: false }];
  assert.equal(fixLoopDecision({ findings, attempt: 0 }).action, "redispatch_implementer");
  assert.equal(fixLoopDecision({ findings, attempt: 3 }).action, "block");
  assert.equal(canSelfApprove({ author_agent: "implementer", reviewer_agent: "implementer" }), true);
  assert.equal(unresolvedHighFindings(findings).length, 1);
});

test("baseline comparison separates new regressions", () => {
  const baseline = {
    results: [
      { id: "test", pass: false },
      { id: "lint", pass: true },
    ],
  };
  const current = {
    results: [
      { id: "test", pass: false },
      { id: "lint", pass: false },
    ],
  };
  const cmp = compareBaselines(baseline, current);
  assert.equal(cmp.pre_existing_failures.length, 1);
  assert.equal(cmp.new_regressions.length, 1);
  assert.equal(cmp.ok, false);
});

test("verification ladder escalates for CRITICAL", () => {
  assert.equal(verificationLadder("LOW").require_full, false);
  assert.equal(verificationLadder("CRITICAL").dual_review, true);
});

test("discoverVerification finds npm test in node projects", () => {
  // This repo itself
  const plan = discoverVerification(process.cwd());
  assert.equal(plan.ecosystem, "node");
  assert.ok(plan.steps.some((s) => s.id === "test"));
  const testStep = plan.steps.find((s) => s.id === "test");
  assert.equal(testStep.command, "npm");
  assert.deepEqual(testStep.args, ["test"]);
});

test("malicious related test filenames are rejected", async () => {
  const { isSafeRelPath, discoverVerification: discover } = await import(
    "../../scripts/lib/verification/discover.js"
  );
  assert.equal(isSafeRelPath("tests/foo.js; rm -rf /"), false);
  assert.equal(isSafeRelPath("tests/$(whoami).js"), false);
  assert.equal(isSafeRelPath("tests/ok.test.js"), true);
  const plan = discover(process.cwd(), {
    related_tests: ["tests/ok.test.js", "evil.js; curl http://x"],
  });
  assert.ok(!plan.steps.some((s) => String(s.id).includes(";")));
  for (const step of plan.steps) {
    assert.ok(Array.isArray(step.args), "steps must use args arrays");
  }
});

test("targeted plans execute the validated target and reject outside-worktree symlinks", () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-targeted-plan-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-targeted-outside-"));
  try {
    fs.mkdirSync(path.join(worktree, "tests"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "tests", "good.test.js"), "// good\n");
    fs.writeFileSync(path.join(worktree, "tests", "other.test.js"), "// other\n");
    fs.writeFileSync(path.join(outside, "outside.test.js"), "// outside\n");
    fs.symlinkSync(
      path.join(outside, "outside.test.js"),
      path.join(worktree, "tests", "linked.test.js"),
    );

    const canonical = filterVerificationPlan(worktree, {
      steps: [
        {
          id: "related:tests/good.test.js",
          command: "npm",
          args: ["test", "--", "tests/other.test.js"],
          kind: "targeted-test",
          target: "tests/good.test.js",
        },
      ],
    });
    assert.equal(canonical.steps.length, 1);
    assert.deepEqual(canonical.steps[0].args, ["test", "--", "tests/good.test.js"]);
    assert.equal(canonical.steps[0].target, "tests/good.test.js");

    const noMarker = filterVerificationPlan(worktree, {
      steps: [
        {
          id: "related:tests/good.test.js",
          command: "node",
          args: ["tests/other.test.js"],
          kind: "targeted-test",
        },
      ],
    });
    assert.deepEqual(noMarker.steps[0].args, ["tests/good.test.js"]);

    const symlink = filterVerificationPlan(worktree, {
      steps: [
        {
          id: "related:tests/linked.test.js",
          command: "npm",
          args: ["test", "--", "tests/linked.test.js"],
          kind: "targeted-test",
        },
      ],
    });
    assert.equal(symlink.steps.length, 0);
    assert.equal(symlink.ignored_targets[0].reason, "outside_worktree");
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("verification provider never uses shell:true", async () => {
  const { createVerificationProvider } = await import(
    "../../scripts/lib/providers/verification-provider.js"
  );
  const provider = createVerificationProvider();
  const run = provider.run({
    worktree: process.cwd(),
    plan: {
      ecosystem: "node",
      steps: [
        {
          id: "noop",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          kind: "generic",
        },
      ],
    },
  });
  assert.equal(run.results[0].pass, true);
  assert.equal(run.results[0].argv[0], process.execPath);
});

test("baseline compare fails on new regressions in gate helper", () => {
  const baseline = {
    results: [{ id: "test", pass: true }],
  };
  const current = {
    results: [{ id: "test", pass: false }],
  };
  const cmp = compareBaselines(baseline, current);
  assert.equal(cmp.ok, false);
  assert.equal(cmp.new_regressions.length, 1);
});
