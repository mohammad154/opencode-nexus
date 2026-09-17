/**
 * Verification provider — discover + run project checks; agent claims are not evidence.
 * Commands always use spawnSync(command, args, { shell: false }).
 */
import fs from "fs";
import path from "path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  discoverVerification,
  filterVerificationPlan,
  isTargetedVerificationStep,
} from "../verification/discover.js";
import { compareBaselines } from "../verification/compare.js";
import { sealProviderArtifact, sha256Digest } from "../artifact-seal.js";
import { validateContainedPath } from "../filesystem-boundary.js";
import { resolveExecutable } from "../resolve-executable.js";

export { resolveExecutable } from "../resolve-executable.js";

const DEFAULT_TIMEOUTS_SECONDS = Object.freeze({
  targetedTest: 300,
  fullTest: 900,
  lint: 300,
  typecheck: 600,
  build: 900,
});

const TIMEOUT_ENV = Object.freeze({
  targetedTest: "NEXUS_VERIFY_TIMEOUT_TARGETED_TEST",
  fullTest: "NEXUS_VERIFY_TIMEOUT_TEST",
  lint: "NEXUS_VERIFY_TIMEOUT_LINT",
  typecheck: "NEXUS_VERIFY_TIMEOUT_TYPECHECK",
  build: "NEXUS_VERIFY_TIMEOUT_BUILD",
});

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function defaultWorkflowPath() {
  const packageRoot = process.env.NEXUS_PKG_ROOT;
  if (packageRoot) return path.join(packageRoot, "config", "default-workflow.json");
  return fileURLToPath(
    new URL("../../../config/default-workflow.json", import.meta.url),
  );
}

function finitePositiveSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Resolve verification step timeouts. Package defaults may be overridden by
 * `.opencode/config/workflow.json`, then environment variables, then an
 * explicit provider/context override (useful for hosts and tests).
 */
export function resolveVerificationTimeouts(worktree, overrides = {}) {
  const packageConfig = readJson(defaultWorkflowPath());
  const root = path.resolve(worktree || process.cwd());
  const projectConfigPath = path.join(root, ".opencode", "config", "workflow.json");
  const projectConfigBoundary = validateContainedPath(root, projectConfigPath, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  const projectConfig = projectConfigBoundary.ok
    ? readJson(projectConfigPath)
    : {};
  const configured = {
    ...DEFAULT_TIMEOUTS_SECONDS,
    ...(packageConfig.verificationTimeouts || {}),
    ...(projectConfig.verificationTimeouts || projectConfig.verification_timeouts || {}),
    ...(overrides.timeouts || overrides.verificationTimeouts || {}),
  };
  const seconds = {};
  for (const [key, fallback] of Object.entries(DEFAULT_TIMEOUTS_SECONDS)) {
    const envValue = process.env[TIMEOUT_ENV[key]];
    seconds[key] =
      finitePositiveSeconds(envValue) ?? finitePositiveSeconds(configured[key]) ?? fallback;
  }
  return Object.fromEntries(
    Object.entries(seconds).map(([key, value]) => [key, Math.max(1, Math.round(value * 1000))]),
  );
}

function timeoutKeyForStep(step = {}) {
  if (step.kind === "targeted-test" || String(step.id || "").startsWith("related:")) {
    return "targetedTest";
  }
  if (step.kind === "lint" || step.id === "lint" || step.id === "vet") return "lint";
  if (step.kind === "typecheck" || step.id === "typecheck" || step.id === "check") {
    return "typecheck";
  }
  if (step.kind === "build" || step.id === "build") return "build";
  return "fullTest";
}

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

/** Map a spawnSync-like result to an exit code. Missing/killed processes fail closed. */
function spawnWasKilledOrMissing(result) {
  if (!result || typeof result !== "object") return true;
  if (result.timed_out === true) return false;
  // A process error is authoritative even when a runner reports a nominal
  // status (some wrappers preserve status: 0 while also returning error).
  if (result.error != null) return true;
  if (result.signal) return true;
  if (result.status == null && result.exit_code == null) return true;
  return false;
}

function runnerErrorMessage(error) {
  if (error == null) return null;
  if (typeof error === "string") return error;
  return String(error.message || error.code || error);
}

function runnerOutput(result) {
  if (!result || typeof result !== "object") return "";
  const stdout = String(result.stdout || "");
  const stderr = result.stderr ? String(result.stderr) : "";
  const error = runnerErrorMessage(result.error);
  return stdout + stderr + (error && !stderr ? error : "");
}

function runnerEvidence(result) {
  const error = runnerErrorMessage(result?.error);
  return {
    error_code: result?.error?.code || null,
    error_message: error,
    signal: result?.signal || null,
    stdout_tail: String(result?.stdout || "").slice(-2000),
    stderr_tail: String(result?.stderr || error || "").slice(-2000),
  };
}

function resolvedSpawnExit(result, failDefault) {
  if (!result || typeof result !== "object") return failDefault;
  if (result.timed_out === true) return failDefault;
  if (spawnWasKilledOrMissing(result)) return failDefault;
  if (result.status != null) return result.status;
  if (result.exit_code != null) return result.exit_code;
  return failDefault;
}

export function runStep(step, worktree, timeoutMs = null, executionOptions = {}) {
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
  const env = executionOptions.env ?? process.env;
  const command = resolveExecutable(step.command, {
    platform: executionOptions.platform ?? process.platform,
    env,
    cwd: worktree || process.cwd(),
    fsModule: executionOptions.fsModule,
    pathModule: executionOptions.pathModule,
    isFile: executionOptions.isFile,
  });
  const spawn = typeof executionOptions.spawnSync === "function"
    ? executionOptions.spawnSync
    : spawnSync;
  const r = spawn(command, step.args, {
    cwd: worktree,
    encoding: "utf8",
    shell: false,
    env,
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeout: timeoutMs } : {}),
  });
  return {
    ...r,
    timed_out: r?.error?.code === "ETIMEDOUT",
    timeout_ms: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null,
  };
}

export function createVerificationProvider(providerOptions = {}) {
  return {
    mode: "nexus-verification",
    supported: true,
    capability: "verification",
    resolveTimeouts(worktree = process.cwd(), overrides = {}) {
      return resolveVerificationTimeouts(worktree, {
        ...providerOptions,
        ...overrides,
      });
    },
    discover(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      return discoverVerification(worktree, ctx);
    },
    run(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      const rawPlan = ctx.plan || discoverVerification(worktree, ctx);
      const plan = filterVerificationPlan(worktree, rawPlan);
      const results = [];
      const timeouts = resolveVerificationTimeouts(worktree, {
        ...providerOptions,
        ...ctx,
      });
      const reusable = new Map(
        (ctx.reuse_results || ctx.reuseResults || [])
          .filter((result) => result?.id && result.pass === true)
          .map((result) => [result.id, result]),
      );
      const onProgress = typeof ctx.onProgress === "function" ? ctx.onProgress : null;
      const totalSteps = (plan.steps || []).length;
      let timedOut = false;
      let executedStepCount = 0;
      for (const skipped of plan.ignored_targets || []) {
        results.push({
          id: `skipped:${skipped.path}`,
          command: null,
          argv: [],
          pass: null,
          status: "SKIPPED",
          reason: skipped.reason,
          path: skipped.path,
          pattern: skipped.pattern || null,
        });
      }
      for (const [index, step] of (plan.steps || []).entries()) {
        if (step.status === "UNAVAILABLE") {
          const result = {
            ...step,
            command: formatCommand(step),
            pass: null,
            status: "UNAVAILABLE",
          };
          results.push(result);
          onProgress?.({ type: "complete", index: index + 1, total: totalSteps, step, result });
          continue;
        }
        const cached = reusable.get(step.id);
        if (cached) {
          const result = {
            ...cached,
            id: step.id,
            command: formatCommand(step),
            argv: [step.command, ...(step.args || [])],
            pass: true,
            status: "REUSED",
            reused: true,
          };
          results.push(result);
          executedStepCount += 1;
          onProgress?.({ type: "reuse", index: index + 1, total: totalSteps, step, result });
          continue;
        }
        const timeoutMs = timeouts[timeoutKeyForStep(step)];
        onProgress?.({ type: "start", index: index + 1, total: totalSteps, step, timeout_ms: timeoutMs });
        const startedAt = Date.now();
        const r = runStep(step, worktree, timeoutMs);
        const spawnFailed = spawnWasKilledOrMissing(r);
        const result = {
          id: step.id,
          command: formatCommand(step),
          argv: [step.command, ...(step.args || [])],
          exit_code: r.status,
          pass: r.status === 0 && !r.timed_out && !spawnFailed,
          status: r.timed_out ? "TIMED_OUT" : r.status === 0 && !spawnFailed ? "PASSED" : "FAILED",
          timed_out: r.timed_out === true,
          timeout_ms: timeoutMs,
          duration_ms: Date.now() - startedAt,
          error_code: r.error?.code || null,
          signal: r.signal || null,
          stdout_tail: String(r.stdout || "").slice(-2000),
          stderr_tail: String(r.stderr || r.error || "").slice(-2000),
        };
        results.push(result);
        executedStepCount += 1;
        onProgress?.({ type: "complete", index: index + 1, total: totalSteps, step, result });
        if (r.timed_out) {
          timedOut = true;
          break;
        }
      }
      const executed = results.filter(
        (r) => r.status !== "UNAVAILABLE" && r.status !== "SKIPPED",
      );
      const hasExecutedChecks = executed.length > 0;
      const allPassed =
        !timedOut && hasExecutedChecks && executed.every((x) => x.pass === true);

      return {
        ok: allPassed,
        ...(hasExecutedChecks ? {} : { code: "VERIFICATION_UNAVAILABLE" }),
        results,
        plan,
        timed_out: timedOut,
        executed_steps: executedStepCount,
        total_steps: totalSteps,
        timeouts,
      };
    },
    baseline(ctx = {}) {
      const run = this.run(ctx);
      const report = {
        schema_version: "1.0",
        ok: true,
        captured_at: new Date().toISOString(),
        commit: ctx.commit || null,
        run_id: ctx.runId || null,
        results: run.results,
      };
      let persistPath = null;
      if (ctx.runId && ctx.worktree) {
        const p = path.join(
          ctx.worktree,
          ".opencode",
          "runs",
          ctx.runId,
          "baseline.json",
        );
        const root = path.resolve(ctx.worktree);
        const boundary = validateContainedPath(root, p, {
          allowMissing: true,
          rejectSymlinks: true,
        });
        if (boundary.ok) {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          const afterMkdir = validateContainedPath(root, p, {
            allowMissing: true,
            rejectSymlinks: true,
          });
          if (afterMkdir.ok) {
            persistPath = p;
          } else {
            report.ok = false;
            report.persist_error = afterMkdir.reason || "persistence_failed";
          }
        } else {
          report.ok = false;
          report.persist_error = boundary.reason || "persistence_failed";
        }
      }
      if (persistPath) report.path = persistPath;
      const sealed = sealProviderArtifact(report, ctx.commit || null);
      if (persistPath) {
        fs.writeFileSync(persistPath, JSON.stringify(sealed, null, 2) + "\n");
      }
      return sealed;
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

      const targetPlan = filterVerificationPlan(worktree, { steps: [step] });
      const targeted = isTargetedVerificationStep(step);
      if (targeted && targetPlan.steps.length === 0) {
        const rejected = targetPlan.ignored_targets[0] || {
          reason: "invalid_target",
          path: "",
        };
        const rejectedReport = {
          schema_version: "1.0",
          test_id: step?.id || "test",
          command: [step?.command, ...(step?.args || [])],
          error: `verification target rejected: ${rejected.reason}`,
          red: { commit: baseCommit || null, exit_code: 1, output_digest: sha256Digest(rejected.reason) },
          green: { commit: implementerCommit || null, exit_code: 1, output_digest: sha256Digest(rejected.reason) },
          ok: false,
        };
        const rejectedHead =
          ctx.worktree_head ||
          (worktree ? gitRevParse(worktree, "HEAD") : null) ||
          implementerCommit ||
          null;
        return sealProviderArtifact(rejectedReport, rejectedHead);
      }
      step = targetPlan.steps[0] || step;

      const runner =
        ctx.runner ||
        ctx.runStep ||
        ((candidate, targetWorktree) =>
          runStep(
            candidate,
            targetWorktree,
            ctx.timeout_ms ||
              resolveVerificationTimeouts(worktree, ctx)[timeoutKeyForStep(candidate)],
          ));

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

      const redExit = resolvedSpawnExit(redResult, 1);
      const greenExit = resolvedSpawnExit(greenResult, 1);

      const redOut = runnerOutput(redResult);
      const greenOut = runnerOutput(greenResult);

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
          ...runnerEvidence(redResult),
        },
        green: {
          commit: implementerCommit || null,
          exit_code: greenExit,
          output_digest: greenDigest,
          ...runnerEvidence(greenResult),
        },
        ok:
          redExit !== 0 &&
          greenExit === 0 &&
          redResult?.timed_out !== true &&
          greenResult?.timed_out !== true &&
          !spawnWasKilledOrMissing(redResult) &&
          !spawnWasKilledOrMissing(greenResult),
        timed_out:
          redResult?.timed_out === true || greenResult?.timed_out === true,
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
