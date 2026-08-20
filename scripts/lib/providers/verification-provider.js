/**
 * Verification provider — discover + run project checks; agent claims are not evidence.
 * Commands always use spawnSync(command, args, { shell: false }).
 */
import fs from "fs";
import path from "path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { discoverVerification } from "../verification/discover.js";
import { compareBaselines } from "../verification/compare.js";
import { sealProviderArtifact, sha256Digest } from "../artifact-seal.js";

function gitRevParse(worktree, rev = "HEAD") {
  if (!worktree) return null;
  try {
    const r = spawnSync("git", ["rev-parse", rev], {
      cwd: worktree,
      encoding: "utf8",
    });
    if (r.status !== 0) return null;
    return String(r.stdout || "").trim() || null;
  } catch {
    return null;
  }
}

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
    verifyTdd(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      const baseCommit = ctx.base_commit || ctx.baseCommit || ctx.base || null;
      const implementerCommit =
        ctx.implementer_commit || ctx.implementerCommit || ctx.commit || null;

      let step;
      if (ctx.step && typeof ctx.step === "object") {
        step = ctx.step;
      } else if (ctx.command) {
        if (Array.isArray(ctx.command)) {
          step = {
            id: ctx.test_id || ctx.testId || "test",
            command: ctx.command[0],
            args: ctx.command.slice(1),
            kind: "test",
          };
        } else if (typeof ctx.command === "string") {
          if (Array.isArray(ctx.args)) {
            step = {
              id: ctx.test_id || ctx.testId || "test",
              command: ctx.command,
              args: ctx.args,
              kind: "test",
            };
          } else {
            const parts = ctx.command.trim().split(/\s+/);
            step = {
              id: ctx.test_id || ctx.testId || "test",
              command: parts[0],
              args: parts.slice(1),
              kind: "test",
            };
          }
        }
      } else {
        const plan = ctx.plan || this.discover(ctx);
        const steps = plan.steps || [];
        let selected = null;
        if (ctx.test_id || ctx.testId) {
          const tid = ctx.test_id || ctx.testId;
          selected = steps.find((s) => s.id === tid);
        }
        if (!selected) {
          selected = steps.find(
            (s) => s.kind === "targeted-test" || s.id?.startsWith("related:"),
          );
        }
        if (!selected) {
          selected = steps.find((s) => s.kind === "test" || s.id === "test");
        }
        if (!selected) {
          selected = steps.find(
            (s) => s.status !== "UNAVAILABLE" && s.command,
          );
        }
        step = selected || {
          id: "test",
          command: "npm",
          args: ["test"],
          kind: "test",
        };
      }

      const runner = ctx.runner || ctx.runStep || runStep;

      let redResult;
      let greenResult;

      if (ctx.runner) {
        redResult = ctx.runner(
          step,
          ctx.base_worktree || worktree,
          baseCommit,
          "red",
        );
        greenResult = ctx.runner(
          step,
          ctx.implementer_worktree || worktree,
          implementerCommit,
          "green",
        );
      } else {
        // Red run (at base_commit or base_worktree)
        if (ctx.base_worktree) {
          redResult = runner(step, ctx.base_worktree);
        } else if (baseCommit) {
          let tempDir = null;
          try {
            tempDir = fs.mkdtempSync(
              path.join(os.tmpdir(), "nexus-tdd-base-"),
            );
            const addRes = spawnSync(
              "git",
              ["worktree", "add", "--detach", tempDir, baseCommit],
              { cwd: worktree, encoding: "utf8" },
            );
            if (addRes.status === 0) {
              redResult = runner(step, tempDir);
            } else {
              redResult = runner(step, worktree);
            }
          } catch {
            redResult = runner(step, worktree);
          } finally {
            if (tempDir) {
              try {
                spawnSync("git", ["worktree", "remove", "--force", tempDir], {
                  cwd: worktree,
                  encoding: "utf8",
                });
              } catch {}
              try {
                if (fs.existsSync(tempDir)) {
                  fs.rmSync(tempDir, { recursive: true, force: true });
                }
              } catch {}
            }
          }
        } else {
          redResult = runner(step, worktree);
        }

        // Green run (at implementer_commit or implementer_worktree or current worktree)
        if (ctx.implementer_worktree) {
          greenResult = runner(step, ctx.implementer_worktree);
        } else {
          greenResult = runner(step, worktree);
        }
      }

      const redExit =
        redResult.status != null
          ? redResult.status
          : redResult.exit_code != null
          ? redResult.exit_code
          : 1;
      const greenExit =
        greenResult.status != null
          ? greenResult.status
          : greenResult.exit_code != null
          ? greenResult.exit_code
          : 0;

      const redOut =
        String(redResult.stdout || "") +
        (redResult.stderr ? String(redResult.stderr) : "");
      const greenOut =
        String(greenResult.stdout || "") +
        (greenResult.stderr ? String(greenResult.stderr) : "");

      const redDigest = sha256Digest(redOut);
      const greenDigest = sha256Digest(greenOut);

      const commandArgv = [step.command, ...(step.args || [])];

      const report = {
        schema_version: "1.0",
        test_id: step.id || "test",
        command: commandArgv,
        red: {
          commit: baseCommit || null,
          exit_code: redExit,
          output_digest: redDigest,
        },
        green: {
          commit: implementerCommit || null,
          exit_code: greenExit,
          output_digest: greenDigest,
        },
        ok: redExit !== 0 && greenExit === 0,
      };

      const worktreeHead =
        ctx.worktree_head ||
        (worktree ? gitRevParse(worktree, "HEAD") : null) ||
        implementerCommit ||
        null;

      return sealProviderArtifact(report, worktreeHead);
    },
  };
}

export function sealTddArtifact(report, worktreeHead = null) {
  return sealProviderArtifact(report, worktreeHead);
}

