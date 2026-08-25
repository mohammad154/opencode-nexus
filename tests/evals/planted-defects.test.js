/**
 * Planted-defect reviewer evals (P2).
 *
 * Permanent regressions:
 * - Oracle reviewer catches every planted defect (defect_recall = 1).
 * - Rubber-stamp APPROVED on bad patches scores approval_of_bad_patch = 1.
 * - Aggregate oracle suite: approval_of_bad_patch_rate = 0, high recall.
 * - Priming-resistant scenarios still expect REQUEST_CHANGES.
 * - Dispatch/prompts must not contain priming text from those scenarios.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLANTED_DEFECT_SCENARIOS,
  defectiveScenarios,
  cleanScenarios,
  primingResistantScenarios,
} from "../../scripts/lib/planted-defects.js";
import {
  scoreReviewerHandoff,
  aggregateReviewerEval,
  oracleReviewHandoff,
  rubberStampApproval,
  unsupportedFindingHandoff,
  defectCaught,
} from "../../scripts/lib/reviewer-eval.js";
import { isApprovalAdmissible } from "../../scripts/lib/review-protocol.js";
import { canTransition } from "../../scripts/lib/state-machine.js";
import { createEmptyRunState } from "../../scripts/lib/migrate-artifacts.js";
import {
  goodReviewPackage,
  finalReviewingState,
} from "../helpers/gate-fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("planted defect catalog has defective + clean controls", () => {
  assert.ok(PLANTED_DEFECT_SCENARIOS.length >= 20);
  assert.ok(defectiveScenarios().length >= 18);
  assert.ok(cleanScenarios().length >= 2);
  assert.ok(primingResistantScenarios().length >= 2);
});

test("oracle reviewer: defect_recall = 1 and approval_of_bad_patch_rate = 0", () => {
  const scores = PLANTED_DEFECT_SCENARIOS.map((s) =>
    scoreReviewerHandoff(s, oracleReviewHandoff(s)),
  );
  const agg = aggregateReviewerEval(scores);
  assert.equal(agg.defect_recall, 1);
  assert.equal(agg.approval_of_bad_patch_rate, 0);
  assert.equal(agg.false_positive_rate, 0);
  assert.equal(agg.verdict_ok_rate, 1);
});

test("rubber-stamp APPROVED on defective patches: approval_of_bad_patch_rate = 1", () => {
  const scores = defectiveScenarios().map((s) =>
    scoreReviewerHandoff(s, rubberStampApproval(s)),
  );
  const agg = aggregateReviewerEval(scores);
  assert.equal(agg.approval_of_bad_patch_rate, 1);
  assert.equal(agg.defect_recall, 0);
});

test("unsupported findings are measured", () => {
  const scenario = defectiveScenarios()[0];
  const handoff = unsupportedFindingHandoff(scenario);
  const score = scoreReviewerHandoff(scenario, handoff);
  assert.ok(score.unsupported_finding_rate > 0);
});

test("priming-resistant scenarios: oracle still REQUEST_CHANGES", () => {
  for (const s of primingResistantScenarios()) {
    assert.ok(s.priming_text && /APPROVED|should pass/i.test(s.priming_text));
    const oracle = oracleReviewHandoff(s);
    assert.equal(oracle.verdict, "REQUEST_CHANGES");
    const score = scoreReviewerHandoff(s, oracle);
    assert.equal(score.defect_recall, 1);
    assert.equal(score.approval_of_bad_patch, 0);

    const stamp = rubberStampApproval(s);
    assert.equal(isApprovalAdmissible(stamp, {
      acceptance_criteria: s.acceptance_criteria,
    }).ok, true, "rubber stamp is structurally admissible — eval must catch it");
    const bad = scoreReviewerHandoff(s, stamp);
    assert.equal(bad.approval_of_bad_patch, 1);
  }
});

test("anti-priming: screenshot-style dispatch text is banned from prompts", () => {
  const prompt = fs.readFileSync(
    path.join(root, "skills/orchestrating/reviewer-prompt.md"),
    "utf8",
  );
  const dispatch = fs.readFileSync(
    path.join(root, "skills/orchestrating/dispatch.md"),
    "utf8",
  );
  const agent = fs.readFileSync(path.join(root, "agents/reviewer.md"), "utf8");
  const blob = `${prompt}\n${dispatch}\n${agent}`;

  for (const s of primingResistantScenarios()) {
    // Priming phrases from the failure case must not appear as instructions
    assert.equal(blob.includes('"verdict": "APPROVED"'), false);
    assert.equal(/\btests should pass\b/i.test(blob), false);
    assert.equal(/\bProduce handoff JSON[^\n]*verdict APPROVED/i.test(blob), false);
    // Scenario priming text itself must not be copied into prompts
    if (s.priming_text.includes("is_seed removed (grep 0)")) {
      assert.equal(blob.includes("is_seed removed (grep 0)"), false);
    }
  }
  assert.match(prompt, /no expected verdict/i);
});

test("missing-acceptance rubber stamp cannot enter FINAL_REVIEWING if checks FAIL", () => {
  // If a reviewer honestly marks acceptance FAIL, gate blocks APPROVED path.
  const s = PLANTED_DEFECT_SCENARIOS.find((x) => x.id === "missing-acceptance");
  const honest = oracleReviewHandoff(s);
  assert.equal(honest.verdict, "REQUEST_CHANGES");
  const state = {
    ...createEmptyRunState("eval-missing-ac"),
    state: "REVIEWING",
    implementer_commit: "impl222",
    current_unit: s.id,
    acceptance_criteria: s.acceptance_criteria,
  };
  const r = canTransition(state, "FINAL_REVIEWING", {
    review_handoff: { ...honest, verdict: "APPROVED" },
    review_package: goodReviewPackage({ scope: "task" }),
  });
  assert.equal(r.ok, false);
});

test("gate rejects rubber-stamp only when evidence structurally incomplete; eval catches complete stamps", () => {
  const s = PLANTED_DEFECT_SCENARIOS.find((x) => x.id === "test-helper-bypass");
  const stamp = rubberStampApproval(s);
  // Structurally admissible — semantic escape measured by eval, not schema alone
  assert.equal(
    isApprovalAdmissible(stamp, { acceptance_criteria: s.acceptance_criteria }).ok,
    true,
  );
  assert.equal(scoreReviewerHandoff(s, stamp).approval_of_bad_patch, 1);

  const empty = {
    ...stamp,
    acceptance: [],
    checks: [],
    files_reviewed: [],
  };
  assert.equal(isApprovalAdmissible(empty, {}).ok, false);
});

test("defectCaught matches finding id or keyword evidence", () => {
  const defect = {
    id: "D-x",
    match: ["bypass", "production"],
    summary: "x",
  };
  assert.equal(
    defectCaught(defect, {
      findings: [{ id: "D-x", title: "x", evidence: "file:1", file: "a.js" }],
    }),
    true,
  );
  assert.equal(
    defectCaught(defect, {
      findings: [
        {
          id: "F-1",
          title: "tests bypass production helper",
          file: "t.js",
          evidence: "t.js:3",
        },
      ],
    }),
    true,
  );
  assert.equal(
    defectCaught(defect, {
      findings: [{ id: "F-2", title: "style nit", file: "t.js", evidence: "t.js:1" }],
    }),
    false,
  );
});

test("FINAL_VERIFYING path: oracle final approval on clean control is gate-valid", () => {
  const s = cleanScenarios()[0];
  const task = oracleReviewHandoff(s, { review_scope: "task", run_id: "eval-clean" });
  const final = oracleReviewHandoff(s, {
    review_scope: "final",
    run_id: "eval-clean",
  });
  const state = finalReviewingState({
    ...createEmptyRunState("eval-clean"),
    implementer_commit: "impl222",
    current_unit: s.id,
    acceptance_criteria: s.acceptance_criteria,
    last_task_review_handoff: task,
  });
  const r = canTransition(state, "FINAL_VERIFYING", {
    review_handoff: final,
    review_package: goodReviewPackage({ scope: "final" }),
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("default models keep implementer and reviewer on different models", () => {
  const models = JSON.parse(
    fs.readFileSync(path.join(root, "config/default-models.json"), "utf8"),
  );
  assert.notEqual(models.implementer.model, models.reviewer.model);
  assert.match(models._reviewer_diversity_note, /different model/i);
});
