#!/usr/bin/env node
/**
 * CLI: nexus eval reviewer — run planted-defect reviewer scoring harness.
 *
 * Usage:
 *   nexus eval reviewer [--json]
 *   nexus eval reviewer --suite oracle|rubber|both [--json]
 */
import {
  PLANTED_DEFECT_SCENARIOS,
} from "./lib/planted-defects.js";
import {
  scoreReviewerHandoff,
  aggregateReviewerEval,
  oracleReviewHandoff,
  rubberStampApproval,
} from "./lib/reviewer-eval.js";

function parseArgs(argv) {
  const out = { json: false, suite: "both", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--suite") out.suite = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function runSuite(name, handoffFn) {
  const scores = PLANTED_DEFECT_SCENARIOS.map((s) =>
    scoreReviewerHandoff(s, handoffFn(s)),
  );
  return { suite: name, aggregate: aggregateReviewerEval(scores), scores };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // argv may be: eval reviewer --json  OR reviewer --json when dispatched
  if (args.help) {
    process.stdout.write(
      "Usage: nexus eval reviewer [--suite oracle|rubber|both] [--json]\n",
    );
    process.exit(0);
  }

  const suites = [];
  if (args.suite === "oracle" || args.suite === "both") {
    suites.push(runSuite("oracle", oracleReviewHandoff));
  }
  if (args.suite === "rubber" || args.suite === "both") {
    suites.push(runSuite("rubber", rubberStampApproval));
  }

  const report = {
    ok: true,
    n_scenarios: PLANTED_DEFECT_SCENARIOS.length,
    suites,
    thresholds: {
      oracle: {
        defect_recall: 1,
        approval_of_bad_patch_rate: 0,
        false_positive_rate: 0,
      },
      rubber: {
        approval_of_bad_patch_rate: 1,
        defect_recall: 0,
      },
    },
  };

  const oracle = suites.find((s) => s.suite === "oracle");
  const rubber = suites.find((s) => s.suite === "rubber");
  if (oracle) {
    if (oracle.aggregate.defect_recall !== 1) report.ok = false;
    if (oracle.aggregate.approval_of_bad_patch_rate !== 0) report.ok = false;
  }
  if (rubber) {
    if (rubber.aggregate.approval_of_bad_patch_rate !== 1) report.ok = false;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const s of suites) {
      process.stdout.write(
        `${s.suite}: recall=${s.aggregate.defect_recall} fp=${s.aggregate.false_positive_rate} bad_approve=${s.aggregate.approval_of_bad_patch_rate} unsupported=${s.aggregate.unsupported_finding_rate}\n`,
      );
    }
    process.stdout.write(report.ok ? "PASS\n" : "FAIL\n");
  }
  process.exit(report.ok ? 0 : 1);
}

main();
