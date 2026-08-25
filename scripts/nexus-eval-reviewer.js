#!/usr/bin/env node
/**
 * CLI: nexus eval reviewer
 *
 * Modes:
 *   --mode deterministic (default): oracle + rubber-stamp synthetic suites
 *   --mode live: score real reviewer handoffs from --handoffs-dir
 *                (or --prepare to emit planted fixtures + review packages)
 *
 * Usage:
 *   nexus eval reviewer [--mode deterministic|live] [--suite oracle|rubber|both]
 *   nexus eval reviewer --mode live --prepare [--out-dir <dir>]
 *   nexus eval reviewer --mode live --handoffs-dir <dir> [--json]
 */
import fs from "fs";
import path from "path";
import {
  PLANTED_DEFECT_SCENARIOS,
  defectiveScenarios,
} from "./lib/planted-defects.js";
import {
  scoreReviewerHandoff,
  aggregateReviewerEval,
  oracleReviewHandoff,
  rubberStampApproval,
} from "./lib/reviewer-eval.js";

function parseArgs(argv) {
  const out = {
    json: false,
    suite: "both",
    mode: "deterministic",
    prepare: false,
    handoffsDir: null,
    outDir: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--suite") out.suite = argv[++i];
    else if (a === "--mode") out.mode = argv[++i];
    else if (a === "--prepare") out.prepare = true;
    else if (a === "--handoffs-dir") out.handoffsDir = argv[++i];
    else if (a === "--out-dir") out.outDir = argv[++i];
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

function prepareLiveFixtures(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const scenariosDir = path.join(outDir, "scenarios");
  const handoffsDir = path.join(outDir, "handoffs");
  fs.mkdirSync(scenariosDir, { recursive: true });
  fs.mkdirSync(handoffsDir, { recursive: true });

  const index = [];
  for (const s of defectiveScenarios()) {
    const scenarioPath = path.join(scenariosDir, `${s.id}.json`);
    fs.writeFileSync(scenarioPath, `${JSON.stringify(s, null, 2)}\n`);
    const briefing = [
      `# Live eval fixture: ${s.id}`,
      "",
      s.title,
      "",
      "## Acceptance",
      ...s.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`),
      "",
      "## Changed files",
      ...s.changed_files.map((f) => `- ${f}`),
      "",
      "## Planted defects (do not show to reviewer in production; for harness only)",
      ...s.defects.map((d) => `- ${d.id}: ${d.summary}`),
      "",
      s.priming_text
        ? `## Priming resistance\n\nThe dispatch MUST NOT include:\n\n\`\`\`\n${s.priming_text}\n\`\`\`\n`
        : "",
      "## Instructions",
      "",
      "1. Materialize a defective patch matching this scenario in a scratch repo.",
      "2. Run: nexus review-package --scope task --json",
      "3. Dispatch the REAL Nexus reviewer (no expected verdict).",
      `4. Save handoff JSON to: handoffs/${s.id}-reviewer.json`,
      "5. Re-run: nexus eval reviewer --mode live --handoffs-dir <out>/handoffs",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(scenariosDir, `${s.id}.md`), briefing);
    index.push({
      id: s.id,
      handoff_path: `handoffs/${s.id}-reviewer.json`,
      scenario_path: `scenarios/${s.id}.json`,
    });
  }
  fs.writeFileSync(
    path.join(outDir, "index.json"),
    `${JSON.stringify({ ok: true, n: index.length, fixtures: index }, null, 2)}\n`,
  );
  return {
    ok: true,
    mode: "live-prepare",
    out_dir: outDir,
    n: index.length,
    next: `Dispatch the real reviewer per scenarios/*.md, then: nexus eval reviewer --mode live --handoffs-dir ${path.join(outDir, "handoffs")}`,
  };
}

function scoreLiveHandoffs(handoffsDir) {
  const scores = [];
  const missing = [];
  for (const s of PLANTED_DEFECT_SCENARIOS) {
    const candidates = [
      path.join(handoffsDir, `${s.id}-reviewer.json`),
      path.join(handoffsDir, `${s.id}.json`),
    ];
    const file = candidates.find((p) => fs.existsSync(p));
    if (!file) {
      if (!s.clean) missing.push(s.id);
      continue;
    }
    const handoff = JSON.parse(fs.readFileSync(file, "utf8"));
    scores.push(scoreReviewerHandoff(s, handoff));
  }
  return {
    ok: missing.length === 0 && scores.length > 0,
    mode: "live",
    n_scored: scores.length,
    missing_handoffs: missing,
    aggregate: aggregateReviewerEval(scores),
    scores,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage:\n" +
        "  nexus eval reviewer [--mode deterministic|live] [--suite oracle|rubber|both] [--json]\n" +
        "  nexus eval reviewer --mode live --prepare [--out-dir .opencode/eval-reviewer]\n" +
        "  nexus eval reviewer --mode live --handoffs-dir <dir> [--json]\n",
    );
    process.exit(0);
  }

  if (args.mode === "live") {
    if (args.prepare) {
      const out =
        args.outDir ||
        path.join(process.cwd(), ".opencode", "eval-reviewer");
      const report = prepareLiveFixtures(out);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exit(0);
    }
    if (!args.handoffsDir) {
      console.error(
        "error: --mode live requires --prepare or --handoffs-dir <dir>",
      );
      process.exit(2);
    }
    const report = scoreLiveHandoffs(args.handoffsDir);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      const a = report.aggregate;
      process.stdout.write(
        `live: scored=${report.n_scored} recall=${a.defect_recall} fp=${a.false_positive_rate} bad_approve=${a.approval_of_bad_patch_rate} unsupported=${a.unsupported_finding_rate}\n`,
      );
      if (report.missing_handoffs?.length) {
        process.stdout.write(
          `missing: ${report.missing_handoffs.join(", ")}\n`,
        );
      }
      process.stdout.write(report.ok ? "PASS\n" : "FAIL\n");
    }
    process.exit(report.ok ? 0 : 1);
  }

  // deterministic (default)
  const suites = [];
  if (args.suite === "oracle" || args.suite === "both") {
    suites.push(runSuite("oracle", oracleReviewHandoff));
  }
  if (args.suite === "rubber" || args.suite === "both") {
    suites.push(runSuite("rubber", rubberStampApproval));
  }

  const report = {
    ok: true,
    mode: "deterministic",
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
    live_hint:
      "For real DeepSeek/Claude reviewer metrics: nexus eval reviewer --mode live --prepare",
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
