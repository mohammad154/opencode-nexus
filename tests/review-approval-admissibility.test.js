/**
 * Evidence-based approval admissibility + anti-priming regression tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isApprovalAdmissible,
  isBlockingFinding,
  MANDATORY_CHECK_CATEGORIES,
} from "../scripts/lib/review-protocol.js";
import { createEmptyRunState } from "../scripts/lib/migrate-artifacts.js";
import { canTransition } from "../scripts/lib/state-machine.js";
import { goodReviewerHandoff } from "./helpers/gate-fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function evidenceApproval(overrides = {}) {
  return goodReviewerHandoff({
    run_id: "adm-run",
    ...overrides,
  });
}

test("isApprovalAdmissible rejects empty APPROVED", () => {
  const r = isApprovalAdmissible({
    verdict: "APPROVED",
    acceptance: [],
    checks: [],
    files_reviewed: [],
    findings: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /acceptance/i.test(e)));
  assert.ok(r.errors.some((e) => /files_reviewed/i.test(e)));
});

test("isApprovalAdmissible requires mandatory check categories", () => {
  const handoff = evidenceApproval({
    checks: [
      {
        category: "correctness",
        status: "PASS",
        evidence: "ok",
      },
    ],
  });
  const r = isApprovalAdmissible(handoff);
  assert.equal(r.ok, false);
  for (const cat of MANDATORY_CHECK_CATEGORIES.filter(
    (c) => c !== "correctness",
  )) {
    assert.ok(r.errors.some((e) => e.includes(cat)));
  }
});

test("isApprovalAdmissible rejects FAIL acceptance even with APPROVED verdict", () => {
  const handoff = evidenceApproval({
    acceptance: [
      {
        id: "AC-1",
        status: "FAIL",
        evidence: [{ file: "src/app.js", line: 1, reason: "missing" }],
      },
    ],
  });
  const r = isApprovalAdmissible(handoff);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /PASS/i.test(e)));
});

test("blocking finding blocks approval even when severity is MEDIUM", () => {
  const handoff = evidenceApproval({
    findings: [
      {
        id: "F-1",
        severity: "MEDIUM",
        blocking: true,
        title: "subtle contract break",
        evidence: "caller still uses old signature",
      },
    ],
  });
  assert.equal(isBlockingFinding(handoff.findings[0]), true);
  const r = isApprovalAdmissible(handoff);
  assert.equal(r.ok, false);
});

test("non-blocking HIGH with blocking:false does not block admissibility", () => {
  const handoff = evidenceApproval({
    findings: [
      {
        id: "F-nits",
        severity: "HIGH",
        blocking: false,
        title: "style nit recorded as high by mistake",
        evidence: "naming only",
      },
    ],
  });
  assert.equal(isBlockingFinding(handoff.findings[0]), false);
  const r = isApprovalAdmissible(handoff);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("FINAL_VERIFYING rejects primed empty approval shape", () => {
  const state = {
    ...createEmptyRunState("adm-empty"),
    state: "FINAL_REVIEWING",
    implementer_commit: "impl222",
    current_unit: "unit-1",
    last_task_review_handoff: evidenceApproval({
      run_id: "adm-empty",
      review_scope: "task",
    }),
  };
  const r = canTransition(state, "FINAL_VERIFYING", {
    review_handoff: {
      schema_version: "1.2",
      run_id: "adm-empty",
      unit_or_task: "unit-1",
      agent: "reviewer",
      base_commit: "base111",
      created_at: "2026-07-30T00:00:00.000Z",
      reviewed_commit: "impl222",
      review_scope: "final",
      verdict: "APPROVED",
      acceptance: [],
      findings: [],
      files_reviewed: [],
      checks: [],
    },
    review_package: {
      ok: true,
      scope: "final",
      path: ".opencode/reviews/x.md",
      base_commit: "base111",
      head_commit: "impl222",
    },
  });
  assert.equal(r.ok, false);
});

test("FINAL_VERIFYING uses review_handoff.findings for blocking", () => {
  const state = {
    ...createEmptyRunState("adm-findings"),
    state: "FINAL_REVIEWING",
    implementer_commit: "impl222",
    current_unit: "unit-1",
    last_task_review_handoff: evidenceApproval({
      run_id: "adm-findings",
      review_scope: "task",
    }),
  };
  const r = canTransition(state, "FINAL_VERIFYING", {
    review_handoff: evidenceApproval({
      run_id: "adm-findings",
      review_scope: "final",
      findings: [
        {
          id: "F-high",
          severity: "HIGH",
          title: "regression",
          evidence: "caller broken",
        },
      ],
    }),
    review_package: {
      ok: true,
      scope: "final",
      path: ".opencode/reviews/x.md",
      base_commit: "base111",
      head_commit: "impl222",
    },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /blocked|admissible|F-high/i.test(e)));
});

test("reviewer prompt does not prime APPROVED", () => {
  const prompt = fs.readFileSync(
    path.join(root, "skills/orchestrating/reviewer-prompt.md"),
    "utf8",
  );
  assert.match(prompt, /no expected verdict/i);
  assert.match(prompt, /decision-after-review/);
  assert.equal(prompt.includes('"verdict": "APPROVED"'), false);
  assert.equal(/\bshould pass\b/i.test(prompt), false);
  assert.equal(/\bexpected to pass\b/i.test(prompt), false);
});

test("agent reviewer.md forbids empty evidence approvals", () => {
  const agent = fs.readFileSync(path.join(root, "agents/reviewer.md"), "utf8");
  assert.match(agent, /no expected verdict/i);
  assert.match(agent, /empty acceptance/i);
});
