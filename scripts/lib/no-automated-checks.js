/**
 * Verification evidence for a direct run whose workspace has no executable
 * check. It is eligible only when the sealed direct edit is the whole change,
 * every changed path is in allowed_files, the workspace is clean since the
 * seal, and the workspace had no test suite at init and has none now.
 *
 * The evidence proves scope and integrity. It is not a test pass, and the
 * verifier reports it as such.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DIRECT_EDIT_COMMIT_MESSAGE } from "./private-baseline.js";
import { isDirectFastPath, sessionPlanLines, workspaceHasTestSuite } from "./fast-path.js";
import {
  changedPathsFromEntries,
  normalizeAllowedFiles,
  normalizeScopePath,
  outOfScopePaths,
  parseStatusZ,
  SCOPE_DRIFT_HINT,
} from "./direct-scope.js";

export const NO_AUTOMATED_CHECKS_MODE = "NO_AUTOMATED_CHECKS";

export const NO_AUTOMATED_CHECKS_WARNING =
  "No executable check ran. This verification proves only that the sealed direct edit stayed within allowed_files and the workspace is clean; no test, lint, or build result backs it.";

function git(gitBin, args, cwd, env) {
  const result = spawnSync(gitBin, args, { cwd, env, encoding: "utf8" });
  return {
    ok: result.status === 0 && !result.error,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "").trim(),
  };
}

function declaredCheck(state) {
  const line = sessionPlanLines(state.fast_path?.session_plan || state.session_plan).find((entry) =>
    /^check:/i.test(entry.trim()),
  );
  const value = line ? line.trim().replace(/^check:\s*/i, "").trim() : "";
  return value || null;
}

function refusal(code, message, extra = {}) {
  return {
    ok: false,
    eligible: true,
    mode: NO_AUTOMATED_CHECKS_MODE,
    code,
    message,
    ...extra,
  };
}

function notEligible(message) {
  return {
    ok: false,
    eligible: false,
    mode: NO_AUTOMATED_CHECKS_MODE,
    code: "VERIFICATION_UNAVAILABLE",
    message,
  };
}

export function noAutomatedCheckEvidence(worktree, state = {}, options = {}) {
  const root = path.resolve(worktree);
  const gitBin = options.gitBin || "git";
  const env = options.env || process.env;

  if (!isDirectFastPath(state)) {
    return notEligible("a standard run needs a runnable project check; only a direct run may verify without one");
  }
  if (state.fast_path?.test_suite !== false) {
    return notEligible(
      "the workspace had a test suite or no recorded probe at init, so its check must run",
    );
  }
  if (workspaceHasTestSuite(root)) {
    return notEligible("the workspace now has a test suite, so its check must run");
  }

  const headCommit = String(options.head || "").trim();
  const sealed = String(state.implementer_commit || "").trim();
  if (!sealed || !headCommit || sealed !== headCommit) {
    return refusal(
      "NO_SEALED_DIRECT_EDIT",
      "HEAD is not the sealed direct edit. Run nexus run transition --to VERIFYING to seal the edit, then verify again.",
    );
  }
  const subject = git(gitBin, ["log", "-1", "--format=%s", sealed], root, env);
  if (!subject.ok || subject.stdout.trim() !== DIRECT_EDIT_COMMIT_MESSAGE) {
    return refusal(
      "NO_SEALED_DIRECT_EDIT",
      "the sealed commit is not a nexus direct edit, so there is no edit to verify. Make the change, then transition to VERIFYING.",
    );
  }

  const diff = git(
    gitBin,
    ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "--no-renames", "-z", sealed],
    root,
    env,
  );
  if (!diff.ok) {
    return refusal("SCOPE_UNVERIFIED", `cannot list the sealed direct edit. ${diff.stderr}`.trim());
  }
  const changed = [...new Set(diff.stdout.split("\0").map(normalizeScopePath).filter(Boolean))].sort();
  if (changed.length === 0) {
    return refusal("NO_SEALED_DIRECT_EDIT", "the sealed direct edit changed no files, so there is nothing to verify");
  }

  const allowed = normalizeAllowedFiles(state.allowed_files);
  if (allowed.length === 0) {
    return refusal("SCOPE_UNVERIFIED", "the run recorded no allowed_files, so the edit scope cannot be proven");
  }
  const outOfScope = outOfScopePaths(changed, allowed);
  if (outOfScope.length > 0) {
    return refusal(
      "DIRECT_SCOPE_DRIFT",
      `the sealed direct edit changed paths outside allowed_files (${outOfScope.join(", ")})`,
      { hint: SCOPE_DRIFT_HINT, out_of_scope: outOfScope, allowed_files: allowed },
    );
  }

  const status = git(gitBin, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], root, env);
  if (!status.ok) {
    return refusal("SCOPE_UNVERIFIED", `cannot read git status to prove the workspace is clean. ${status.stderr}`.trim());
  }
  const unsealed = changedPathsFromEntries(parseStatusZ(status.stdout));
  if (unsealed.length > 0) {
    return refusal(
      "DIRECT_SCOPE_DRIFT",
      `the workspace changed after the direct edit was sealed (${unsealed.join(", ")})`,
      { hint: SCOPE_DRIFT_HINT, unsealed_paths: unsealed, allowed_files: allowed },
    );
  }

  return {
    ok: true,
    eligible: true,
    mode: NO_AUTOMATED_CHECKS_MODE,
    code: null,
    message: NO_AUTOMATED_CHECKS_WARNING,
    commit: sealed,
    changed_paths: changed,
    allowed_files: allowed,
    declared_check: declaredCheck(state),
  };
}
