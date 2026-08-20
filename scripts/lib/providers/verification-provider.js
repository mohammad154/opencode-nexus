/**
 * Verification provider — discover + run project checks; agent claims are not evidence.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { discoverVerification } from "../verification/discover.js";
import { compareBaselines } from "../verification/compare.js";

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
          results.push({ ...step, pass: null, status: "UNAVAILABLE" });
          continue;
        }
        const r = spawnSync(step.command, {
          cwd: worktree,
          encoding: "utf8",
          shell: true,
          env: process.env,
        });
        results.push({
          id: step.id,
          command: step.command,
          exit_code: r.status,
          pass: r.status === 0,
          stdout_tail: String(r.stdout || "").slice(-2000),
          stderr_tail: String(r.stderr || "").slice(-2000),
        });
      }
      return {
        ok: results.every((x) => x.pass === true || x.status === "UNAVAILABLE"),
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
