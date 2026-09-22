/**
 * PR6 reviewer-efficiency evals.
 *
 * Permanent regressions:
 * - The deterministic eval gate keeps its replay and probe suites, so the
 *   "consume sealed evidence" contract cannot be quietly dropped.
 * - A declared re-run of a sealed passing command is never admissible.
 * - A focused probe stays admissible: PR6 removes blind replay, not testing.
 * - Reviewer quality metrics (recall / false positives / bad approvals) are
 *   unchanged by the leaner packages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PLANTED_DEFECT_SCENARIOS } from "../../scripts/lib/planted-defects.js";
import {
  EVAL_SEALED_VERIFICATION,
  aggregateReviewerEval,
  focusedProbeApproval,
  oracleReviewHandoff,
  rubberStampApproval,
  scoreReviewerHandoff,
  sealedReplayApproval,
  undeclaredProbeApproval,
} from "../../scripts/lib/reviewer-eval.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function suite(handoffFn) {
  return aggregateReviewerEval(
    PLANTED_DEFECT_SCENARIOS.map((scenario) =>
      scoreReviewerHandoff(scenario, handoffFn(scenario)),
    ),
  );
}

test("oracle reviewer quality is unchanged and never replays sealed commands", () => {
  const oracle = suite(oracleReviewHandoff);
  assert.equal(oracle.defect_recall, 1);
  assert.equal(oracle.false_positive_rate, 0);
  assert.equal(oracle.approval_of_bad_patch_rate, 0);
  assert.equal(oracle.unsupported_finding_rate, 0);
  assert.equal(oracle.verdict_ok_rate, 1);
  assert.equal(oracle.adversarial_command_total, 0);
  assert.equal(oracle.duplicate_sealed_rerun_rate, 0);
});

test("rubber-stamp approvals still score as bad approvals", () => {
  const rubber = suite(rubberStampApproval);
  assert.equal(rubber.approval_of_bad_patch_rate, 1);
  assert.equal(rubber.admissible_rate, 1);
  assert.equal(rubber.duplicate_command_total, 0);
});

test("declared replay of sealed passing evidence is never admissible", () => {
  const replay = suite(sealedReplayApproval);
  assert.equal(replay.admissible_rate, 0);
  assert.equal(replay.duplicate_sealed_rerun_rate, 1);
  assert.equal(replay.duplicate_command_total, PLANTED_DEFECT_SCENARIOS.length);
  // Nothing was approved, so a replayed rubber stamp cannot pass a bad patch.
  assert.equal(replay.approval_of_bad_patch_rate, 0);
});

test("focused probes stay admissible and are counted, not penalized", () => {
  const probe = suite(focusedProbeApproval);
  assert.equal(probe.admissible_rate, 1);
  assert.equal(probe.duplicate_sealed_rerun_rate, 0);
  assert.equal(probe.adversarial_command_total, PLANTED_DEFECT_SCENARIOS.length);
});

test("an undeclared command is inadmissible even when it is not a replay", () => {
  const undeclared = suite(undeclaredProbeApproval);
  assert.equal(undeclared.admissible_rate, 0);
  assert.equal(undeclared.duplicate_sealed_rerun_rate, 0);
});

test("sealed eval evidence lists passing commands the reviewer must consume", () => {
  assert.equal(EVAL_SEALED_VERIFICATION.ok, true);
  assert.deepEqual(
    EVAL_SEALED_VERIFICATION.results.map((step) => [step.command, step.pass]),
    [
      ["npm test", true],
      ["npm run lint", true],
    ],
  );
});

test("nexus eval reviewer gates the replay and probe suites", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "bin", "nexus.js"), "eval", "reviewer", "--json"],
    { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
  );
  const stderr = result.stderr?.toString("utf8") ?? "";
  assert.equal(result.status, 0, stderr);
  const report = JSON.parse(result.stdout?.toString("utf8") ?? "");
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.suites.map((entry) => entry.suite),
    ["oracle", "rubber", "replay", "probe"],
  );
  assert.deepEqual(report.thresholds.replay, {
    admissible_rate: 0,
    duplicate_sealed_rerun_rate: 1,
  });
  assert.deepEqual(report.thresholds.probe, {
    admissible_rate: 1,
    duplicate_sealed_rerun_rate: 0,
  });
  const byName = Object.fromEntries(
    report.suites.map((entry) => [entry.suite, entry.aggregate]),
  );
  assert.equal(byName.oracle.defect_recall, 1);
  assert.equal(byName.oracle.approval_of_bad_patch_rate, 0);
  assert.equal(byName.replay.admissible_rate, 0);
  assert.equal(byName.probe.admissible_rate, 1);
});
