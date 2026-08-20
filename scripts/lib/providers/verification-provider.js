/**
 * Verification provider — discover + run project checks; agent claims are not evidence.
 * Commands always use spawnSync(command, args, { shell: false }).
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { discoverVerification } from "../verification/discover.js";
import { compareBaselines } from "../verification/compare.js";

function formatCommand(step) {
  const args = Array.isArray(step.args) ? step.args : [];
  return [step.command, ...args].join(" ");
}

function runStep(step, worktree) {
  if (!step.command || typeof step.command !== "string") {
    return {
      status: 1,
      error: "verification step missing command",
      stdout: "",
      stderr: "missing command",
    };
  }
  if (!Array.isArray(step.args)) {
    return {
      status: 1,
      error: "verification step must use args[] (shell strings rejected)",
      stdout: "",
      stderr: "args required",
    };
  }
  const r = spawnSync(step.command, step.args, {
    cwd: worktree,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  return r;
}

export function createVerificationProvider() {
  return {
    mode: "nexus-verification",
    supported: true,
    capability: "verification",
    discover(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      return discoverVerification(worktree, ctx);
    },
    run(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      const plan = ctx.plan || discoverVerification(worktree, ctx);
      const results = [];
      for (const step of plan.steps || []) {
        if (step.status === "UNAVAILABLE") {
          results.push({
            ...step,
            command: formatCommand(step),
            pass: null,
            status: "UNAVAILABLE",
          });
          continue;
        }
        const r = runStep(step, worktree);
        results.push({
          id: step.id,
          command: formatCommand(step),
          argv: [step.command, ...(step.args || [])],
          exit_code: r.status,
          pass: r.status === 0,
          stdout_tail: String(r.stdout || "").slice(-2000),
          stderr_tail: String(r.stderr || r.error || "").slice(-2000),
        });
      }
      const executed = results.filter(
        (r) => r.status !== "UNAVAILABLE" && r.exit_code != null,
      );
      const hasExecutedChecks = executed.length > 0;
      const allPassed =
        hasExecutedChecks && executed.every((x) => x.pass === true);

      return {
        ok: allPassed,
        ...(hasExecutedChecks ? {} : { code: "VERIFICATION_UNAVAILABLE" }),
        results,
        plan,
      };
    },
    baseline(ctx = {}) {
      const run = this.run(ctx);
      const report = {
        schema_version: "1.0",
        captured_at: new Date().toISOString(),
        commit: ctx.commit || null,
        results: run.results,
      };
      if (ctx.runId && ctx.worktree) {
        const p = path.join(
          ctx.worktree,
          ".opencode",
          "runs",
          ctx.runId,
          "baseline.json",
        );
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(report, null, 2) + "\n");
        report.path = p;
      }
      return report;
    },
    compare(baseline, current) {
      return compareBaselines(baseline, current);
    },
  };
}
