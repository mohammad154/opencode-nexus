import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeAndValidateHandoff,
  createEmptyRunState,
} from "../../scripts/lib/migrate-artifacts.js";
import { canTransition, transition } from "../../scripts/lib/state-machine.js";
import {
  mockTrustProviders,
  sealedVerification,
  sealedImpact,
} from "../helpers/gate-fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

/**
 * Build a handoff object from the documented implementer template field list.
 * Ensures the documented workflow produces gate-valid handoffs.
 */
function handoffFromImplementerTemplate({
  runId = "contract-run",
  unit = "unit-contract",
  base = "baseaaa",
  commit = "commitbb",
} = {}) {
  const prompt = read("skills/nexus-orchestrating/implementer-prompt.md");
  assert.match(prompt, /schema_version: "1\.1"/);
  assert.match(prompt, /development_checks/);
  assert.match(prompt, /verification_gates/); // documented compatibility alias
  assert.match(prompt, /drift_check/);
  assert.match(prompt, /Do NOT set verification_exempt/);
  assert.equal(prompt.includes("verification_exempt"), true); // mentioned as forbidden
  assert.match(prompt, /base_commit/);

  return {
    schema_version: "1.1",
    run_id: runId,
    unit_or_task: unit,
    agent: "implementer",
    base_commit: base,
    created_at: "2026-07-30T12:00:00.000Z",
    status: "DONE",
    commit,
    files_changed: ["src/example.js"],
    allowed_files: ["src/example.js"],
    tests: ["node --test tests/example.test.js"],
    tasks_completed: [unit],
    notes_for_reviewer: "from template contract",
    scope_extras: [],
    development_checks: [
      { id: "regression-test", cmd: "node --test tests/example.test.js", pass: true },
    ],
    drift_check: { plan_commit: base, current_head: commit, pass: true },
    blast: { risk: "LOW", verified: true, callers_checked: [] },
  };
}

function handoffFromReviewerTemplate({
  runId = "contract-run",
  unit = "unit-contract",
  base = "baseaaa",
  commit = "commitbb",
} = {}) {
  const prompt = read("skills/nexus-orchestrating/reviewer-prompt.md");
  assert.match(prompt, /"schema_version": "1\.2"/);
  assert.match(prompt, /reviewed_commit/);
  assert.match(prompt, /run_id/);
  assert.match(prompt, /"agent": "reviewer"/);
  assert.match(prompt, /files_reviewed/);
  assert.match(prompt, /no expected verdict/i);
  assert.match(prompt, /decision-after-review/);
  // Anti-priming: sample must not hard-code APPROVED as the example verdict
  assert.equal(prompt.includes('"verdict": "APPROVED"'), false);
  assert.equal(/should pass/i.test(prompt), false);

  return {
    schema_version: "1.2",
    run_id: runId,
    unit_or_task: unit,
    agent: "reviewer",
    base_commit: base,
    created_at: "2026-07-30T12:00:00.000Z",
    reviewed_commit: commit,
    review_scope: "task",
    verdict: "APPROVED",
    files_reviewed: ["src/example.js"],
    acceptance: [
      {
        id: "AC-1",
        status: "PASS",
        evidence: [
          {
            file: "src/example.js",
            line: 10,
            reason: "Criterion satisfied in production change",
          },
        ],
      },
    ],
    checks: [
      {
        category: "correctness",
        status: "PASS",
        evidence: "Diff matches acceptance for unit-contract",
      },
      {
        category: "test_quality",
        status: "PASS",
        evidence: "Tests call production module",
      },
      {
        category: "impact",
        status: "PASS",
        evidence: "Post-impact callers unchanged",
      },
    ],
    findings: [],
    notes: "from template contract",
    impact: { pass: true, risk: "LOW" },
  };
}

test("documented implementer template produces a gate-valid handoff", () => {
  const handoff = handoffFromImplementerTemplate();
  const { ok, errors, data } = normalizeAndValidateHandoff(
    "implementer",
    handoff,
  );
  assert.equal(ok, true, JSON.stringify(errors));
  assert.equal(data.legacy_unverified, undefined);
  assert.equal(data.schema_version, "1.1");

  const state = {
    ...createEmptyRunState("contract-run"),
    state: "IMPLEMENTING",
    current_unit: "unit-contract",
    head_commit: "baseaaa",
    review_level: "unified",
    execution_mode: "delegated",
  };
  const verifying = canTransition(state, "VERIFYING", {
    provider_verification: sealedVerification(),
    post_impact: sealedImpact({ phase: "post" }),
    implementer_handoff: handoff,
  });
  assert.equal(verifying.ok, true, JSON.stringify(verifying.errors));

  const applied = transition(
    state,
    "VERIFYING",
    { implementer_handoff: handoff },
    mockTrustProviders(),
  );
  assert.equal(applied.ok, true, JSON.stringify(applied.errors));
  assert.equal(applied.state.implementer_commit, "commitbb");
});

test("documented reviewer template produces a gate-valid evidence-backed approval", () => {
  const handoff = handoffFromReviewerTemplate();
  const { ok, errors, data } = normalizeAndValidateHandoff("reviewer", handoff);
  assert.equal(ok, true, JSON.stringify(errors));
  assert.equal(data.agent, "reviewer");
  assert.equal(data.schema_version, "1.2");

  const taskPkg = {
    schema_version: "1.0",
    ok: true,
    scope: "task",
    run_id: "contract-run",
    unit_or_task: "unit-contract",
    run_base_commit: "baseaaa",
    path: ".opencode/reviews/contract-task.md",
    absolute_path: "/repo/.opencode/reviews/contract-task.md",
    meta_path: ".opencode/reviews/contract-task.json",
    base_commit: "baseaaa",
    head_commit: "commitbb",
    digest_sha256: "a".repeat(64),
    changed_files: ["src/example.js"],
    production_files: ["src/example.js"],
    acceptance_criteria: [],
    generated_at: "2026-07-30T12:00:00.000Z",
  };
  const reviewing = {
    ...createEmptyRunState("contract-run"),
    state: "REVIEWING",
    current_unit: "unit-contract",
    head_commit: "baseaaa",
    implementer_commit: "commitbb",
    run_base_commit: "baseaaa",
  };
  const toFinalReview = canTransition(reviewing, "FINAL_REVIEWING", {
    review_handoff: data,
    review_package: taskPkg,
  });
  assert.equal(toFinalReview.ok, true, JSON.stringify(toFinalReview.errors));

  const finalHandoff = {
    ...data,
    review_scope: "final",
  };
  const finalReviewing = {
    ...reviewing,
    state: "FINAL_REVIEWING",
    last_task_review_handoff: data,
    last_review_handoff: data,
  };
  const final = canTransition(finalReviewing, "FINAL_VERIFYING", {
    review_handoff: finalHandoff,
    review_package: {
      ...taskPkg,
      scope: "final",
      path: ".opencode/reviews/contract-final.md",
    },
  });
  assert.equal(final.ok, true, JSON.stringify(final.errors));
});

test("empty APPROVED (zero acceptance / checks) is gate-invalid", () => {
  const emptyApproval = {
    schema_version: "1.2",
    run_id: "contract-run",
    unit_or_task: "unit-contract",
    agent: "reviewer",
    base_commit: "baseaaa",
    created_at: "2026-07-30T12:00:00.000Z",
    reviewed_commit: "commitbb",
    review_scope: "task",
    verdict: "APPROVED",
    acceptance: [],
    findings: [],
    files_reviewed: [],
    checks: [],
  };
  const { ok, data } = normalizeAndValidateHandoff("reviewer", emptyApproval);
  assert.equal(
    ok,
    true,
    "schema still allows REQUEST_CHANGES-shaped empties structurally",
  );
  const state = {
    ...createEmptyRunState("contract-run"),
    state: "REVIEWING",
    current_unit: "unit-contract",
    implementer_commit: "commitbb",
  };
  const final = canTransition(state, "FINAL_REVIEWING", {
    review_handoff: data,
    review_package: {
      ok: true,
      scope: "task",
      path: ".opencode/reviews/x.md",
      base_commit: "baseaaa",
      head_commit: "commitbb",
    },
  });
  assert.equal(final.ok, false);
  assert.ok(
    final.errors.some((e) =>
      /approval not admissible|acceptance|files_reviewed/i.test(e),
    ),
  );
});

test("OpenCode compact router uses nexus-prefixed skill names", () => {
  const plugin = read(".opencode/plugins/nexus.js");
  assert.match(plugin, /→ nexus-using-nexus/);
  assert.match(plugin, /→ nexus-brainstorming/);
  assert.equal(plugin.includes("→ using-nexus"), false);
});

test("CI runs npm test", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /run:\s*npm test/);
});

test("CI workflows expose stable required-check names", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /\n  ci:\n\s+name: CI\n/);
  assert.match(ci, /needs: \[test, install\]/);

  const security = read(".github/workflows/plugin-security-scan.yml");
  assert.match(
    security,
    /jobs:\s*\n\s+scan:\s*\n\s+name: Plugin Security Scan\n/,
  );
});
