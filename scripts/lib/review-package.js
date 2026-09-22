/**
 * Deterministic Review Package — prepared before reviewer dispatch.
 * Scripts measure; the reviewer treats implementer claims as unverified.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { isLikelyProductionPath } from "./review-protocol.js";
import { validateContainedPath } from "./filesystem-boundary.js";
import { normalizePlan } from "./plan-check.js";

/**
 * Selection budgets (PR6.B/C).
 *
 * The package is a *selection*, not a dump. Lowering a diff ceiling alone would
 * truncate arbitrary evidence at an arbitrary byte; instead each section has a
 * purpose, files are ordered by review value (production → tests → other), and
 * every omission names the exact read-only command that retrieves the rest.
 */
export const REVIEW_SELECTION_VERSION = "nexus-review-selection/1";
const DEFAULT_TASK_HUNK_BYTES = 60_000;
const DEFAULT_FINAL_HUNK_BYTES = 60_000;
const DEFAULT_PER_FILE_HUNK_BYTES = 12_000;
const DEFAULT_DIFF_STAT_BYTES = 12_000;

function runGit(worktree, args) {
  try {
    const r = spawnSync("git", args, {
      cwd: worktree,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      ok: r.status === 0,
      stdout: String(r.stdout || ""),
      stderr: String(r.stderr || ""),
      status: r.status,
      error: r.error || null,
    };
  } catch (error) {
    return { ok: false, stdout: "", stderr: "", status: null, error };
  }
}

function revParse(worktree, rev) {
  const r = runGit(worktree, ["rev-parse", rev]);
  return r.ok ? r.stdout.trim() : null;
}

function clamp(text, max, label = "output") {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[${label} truncated: ${value.length - max} more chars]…\n`;
}

function isTestPath(file) {
  const f = String(file || "").replace(/\\/g, "/");
  return (
    /(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(f) ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(f)
  );
}

/**
 * Files whose change can break a consumer outside the unit: entry points,
 * published surfaces, schemas, routes, migrations, and dependency manifests.
 */
export function isSharedContractPath(file) {
  const f = String(file || "").replace(/\\/g, "/");
  if (!f || f.startsWith(".opencode/")) return false;
  return (
    /(^|\/)(index|main|api|server|app|router|routes|schema|schemas|types|contracts?|public)([./]|$)/i.test(f) ||
    /\.(proto|graphql|sql)$/i.test(f) ||
    /(^|\/)migrations?(\/|$)/i.test(f) ||
    /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|go\.mod|Cargo\.toml|composer\.json)$/i.test(f) ||
    /(^|\/)openapi[^/]*$/i.test(f)
  );
}

/** Review-ordered file list: production first, then tests, then the remainder. */
function reviewOrderedFiles(files) {
  const unique = [...new Set((files || []).filter(Boolean))];
  const production = unique.filter(
    (file) => isLikelyProductionPath(file) && !isTestPath(file),
  );
  const tests = unique.filter((file) => isTestPath(file));
  const rest = unique.filter(
    (file) => !production.includes(file) && !tests.includes(file),
  );
  return { production, tests, rest, ordered: [...production, ...tests, ...rest] };
}

/**
 * Split one `git diff` output into per-file bodies, keyed by the post-image
 * path (falling back to the pre-image path for deletions).
 */
function splitDiffByFile(result) {
  const byFile = new Map();
  if (!result?.ok) return { ok: false, byFile };
  const text = String(result.stdout || "");
  const matches = [...text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  for (const [index, match] of matches.entries()) {
    const start = match.index;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const body = text.slice(start, end);
    const key = match[2] === "/dev/null" ? match[1] : match[2];
    byFile.set(key, (byFile.get(key) || "") + body);
  }
  return { ok: true, byFile };
}

/**
 * Per-file diff hunks under an explicit budget.
 *
 * Every file is either included (possibly clipped with its own retrieval
 * command) or listed as omitted with the command that shows it. Nothing is
 * silently dropped.
 */
function selectFocusedHunks(worktree, base, head, files, options = {}) {
  const budget = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_TASK_HUNK_BYTES;
  const perFile =
    Number(options.maxPerFileBytes) > 0
      ? Number(options.maxPerFileBytes)
      : DEFAULT_PER_FILE_HUNK_BYTES;
  const sections = [];
  const included = [];
  const omitted = [];
  const clipped = [];
  let used = 0;
  // One git invocation for the whole selection, then split per file: the
  // selection stays per-file while reviewer-dispatch latency stays flat.
  const perFileDiffs = splitDiffByFile(
    files.length > 0
      ? runGit(worktree, ["diff", "--find-renames", base, head, "--", ...files])
      : { ok: true, stdout: "" },
  );
  for (const file of files) {
    const diff = perFileDiffs;
    if (!diff.ok) {
      omitted.push({ file, reason: "DIFF_UNAVAILABLE" });
      continue;
    }
    const text = (diff.byFile.get(file) || "").trimEnd();
    if (!text) {
      omitted.push({ file, reason: "EMPTY_DIFF" });
      continue;
    }
    if (used >= budget) {
      omitted.push({ file, reason: "SELECTION_BUDGET" });
      continue;
    }
    const remaining = budget - used;
    const notice = `\n…[${file} hunks clipped; read the rest with: git diff ${base} ${head} -- ${file}]…`;
    const allowance = Math.min(perFile, remaining);
    // The clipping notice is part of the output, so it is charged to the budget:
    // `hunk_bytes` never exceeds `hunk_budget_bytes`.
    const clippedAllowance = Math.max(0, allowance - notice.length);
    const body =
      text.length <= allowance
        ? text
        : `${text.slice(0, clippedAllowance)}${notice}`;
    if (text.length > allowance) clipped.push({ file, bytes: text.length });
    sections.push(["```diff", body, "```"].join("\n"));
    included.push(file);
    used += body.length;
  }
  return {
    text: sections.join("\n\n"),
    bytes: used,
    included,
    omitted,
    clipped,
    budget,
  };
}

function safeRead(filePath, max = 80_000) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf8");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…[truncated ${text.length - max} chars]…\n`;
}

/**
 * The execution unit under review, derived from the normalized plan instead of a
 * blind PLAN.md excerpt. Reuses the canonical plan parser — no second parser.
 */
function currentUnitFromPlan(planPath, unitId) {
  let text;
  try {
    text = fs.readFileSync(planPath, "utf8");
  } catch {
    return null;
  }
  const plan = normalizePlan(text);
  const units = Array.isArray(plan.execution_units) ? plan.execution_units : [];
  const unit =
    units.find((candidate) => candidate.id === unitId) ||
    units.find((candidate) => String(candidate.title || "") === String(unitId)) ||
    (units.length === 1 ? units[0] : null);
  return {
    plan_goal: plan.goal || null,
    plan_non_goals: Array.isArray(plan.non_goals) ? plan.non_goals : [],
    plan_commit: plan.plan_commit || null,
    planning_mode: plan.planning_mode || null,
    unit_count: units.length,
    unit: unit
      ? {
          id: unit.id,
          title: unit.title || null,
          user_outcome: unit.user_outcome || null,
          review_boundary: unit.review_boundary || null,
          estimated_lines: unit.estimated_lines ?? null,
          independently_shippable: unit.independently_shippable ?? null,
          allowed_files: Array.isArray(unit.allowed_files) ? unit.allowed_files : [],
          evidence: Array.isArray(unit.evidence) ? unit.evidence : [],
          acceptance_criteria: Array.isArray(unit.acceptance_criteria)
            ? unit.acceptance_criteria
            : [],
          verification_gates: Array.isArray(unit.verification_gates)
            ? unit.verification_gates
            : [],
          stop_conditions: Array.isArray(unit.stop_conditions) ? unit.stop_conditions : [],
        }
      : null,
  };
}

/** Sealed deterministic commands the reviewer must consume rather than replay. */
export function sealedCommandsFromVerification(verification) {
  const results = Array.isArray(verification?.results) ? verification.results : [];
  return results
    .filter((step) => step && (step.command || (step.argv || []).length > 0))
    .map((step) => ({
      id: step.id || null,
      command:
        typeof step.command === "string" && step.command.trim()
          ? step.command.trim()
          : (step.argv || []).join(" "),
      argv: Array.isArray(step.argv) ? step.argv : null,
      pass: step.pass === true,
      status: step.status || (step.pass === true ? "PASSED" : null),
      duration_ms: Number.isFinite(step.duration_ms) ? step.duration_ms : null,
      reused: step.reused === true,
      identity: typeof step.identity === "string" ? step.identity : null,
    }));
}

function impactSelection(impact, changedFiles) {
  if (!impact || typeof impact !== "object") return null;
  const changed = new Set(changedFiles || []);
  const dependents = [];
  const raw = impact.direct_dependents;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [file, list] of Object.entries(raw)) {
      if (changed.size > 0 && !changed.has(file)) continue;
      const callers = [...new Set((Array.isArray(list) ? list : []).map(String))];
      if (callers.length > 0) dependents.push({ file, callers });
    }
  } else if (Array.isArray(raw)) {
    dependents.push({ file: "(aggregate)", callers: raw.map(String) });
  }
  const relatedTests = [...new Set((impact.related_tests || []).map(String))];
  return {
    risk: impact.risk || impact.level || "UNKNOWN",
    ok: impact.ok,
    confidence: impact.confidence ?? null,
    changed_file_count: (impact.changed_files || []).length,
    dependents,
    related_tests: relatedTests,
  };
}

function summarizeImpactSelection(selection) {
  if (!selection) return "_No impact report attached._";
  const lines = [
    `- risk: ${selection.risk}`,
    `- ok: ${selection.ok}`,
    `- confidence: ${selection.confidence ?? "n/a"}`,
    `- impact changed_files: ${selection.changed_file_count}`,
  ];
  if (selection.dependents.length > 0) {
    lines.push("- callers of changed files (review for regressions):");
    for (const entry of selection.dependents.slice(0, 20)) {
      lines.push(
        `  - ${entry.file} ← ${entry.callers.slice(0, 8).join(", ")}${entry.callers.length > 8 ? `, +${entry.callers.length - 8} more` : ""}`,
      );
    }
  } else {
    lines.push("- callers of changed files: none reported");
  }
  lines.push(
    `- related tests: ${selection.related_tests.slice(0, 20).join(", ") || "none reported"}`,
  );
  return lines.join("\n");
}

/**
 * Sealed verification summary. This is the authoritative deterministic evidence:
 * the reviewer consumes it and must not re-run a passing command to reconfirm.
 */
function summarizeSealedVerification(verification, sealedCommands) {
  if (!verification || typeof verification !== "object") {
    return "_No sealed verification report attached._";
  }
  const lines = [
    `- sealed ok: ${verification.ok}`,
    `- steps: ${sealedCommands.length}`,
    "- commands already proven at this identity (do not re-run to reconfirm):",
  ];
  for (const step of sealedCommands.slice(0, 30)) {
    lines.push(
      `  - \`${step.command}\` → ${step.status || (step.pass ? "PASSED" : "UNKNOWN")}${
        step.duration_ms != null ? ` (${step.duration_ms} ms)` : ""
      }${step.reused ? " [reused sealed result]" : ""}`,
    );
  }
  if (sealedCommands.length > 30) {
    lines.push(`  - …${sealedCommands.length - 30} more sealed steps`);
  }
  lines.push(
    "- run a command only for a specific new hypothesis these checks do not answer, and record it in `adversarial_checks` with `hypothesis`, `command`, and `reason`.",
  );
  return lines.join("\n");
}

function isCommitAncestor(worktree, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  if (ancestor === descendant) return true;
  return runGit(worktree, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;
}

function filesChangedBetween(worktree, base, head) {
  if (!isCommitAncestor(worktree, base, head)) return null;
  const result = runGit(worktree, ["diff", "--name-only", base, head]);
  if (!result.ok) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
}

/**
 * Per-unit change ranges across the run, so the final reviewer can see *which
 * unit* produced a file and where units overlap. Ranges are derived from the
 * recorded reviewed commits, not from reviewer claims.
 */
function unitChangeRanges(worktree, runState, headCommit) {
  const history = Array.isArray(runState.task_history) ? runState.task_history : [];
  const ranges = [];
  let base = runState.run_base_commit || runState.plan_commit || null;
  for (const entry of history) {
    const head = entry?.reviewed_commit || null;
    if (!base || !head) {
      ranges.push({ unit_or_task: entry?.id || null, base, head, files: null });
      continue;
    }
    ranges.push({
      unit_or_task: entry?.id || null,
      base,
      head,
      files: filesChangedBetween(worktree, base, head),
    });
    base = head;
  }
  if (base && headCommit && base !== headCommit) {
    ranges.push({
      unit_or_task: runState.current_unit || "(after last approval)",
      base,
      head: headCommit,
      files: filesChangedBetween(worktree, base, headCommit),
    });
  }
  return ranges;
}

/**
 * Integration surface for a final review: files more than one unit touched,
 * shared/public contract changes, and the highest fan-in changed files.
 */
function integrationSelection(ranges, changedFiles, impactSelection_) {
  const owners = new Map();
  for (const range of ranges) {
    for (const file of range.files || []) {
      if (!owners.has(file)) owners.set(file, new Set());
      owners.get(file).add(range.unit_or_task || "(unknown)");
    }
  }
  const crossUnitFiles = [...owners.entries()]
    .filter(([, units]) => units.size > 1)
    .map(([file, units]) => ({ file, units: [...units].sort() }))
    .sort((left, right) => (left.file < right.file ? -1 : 1));
  const contractFiles = (changedFiles || []).filter(isSharedContractPath);
  const fanIn = (impactSelection_?.dependents || [])
    .map((entry) => ({ file: entry.file, callers: entry.callers.length }))
    .sort((left, right) => right.callers - left.callers)
    .slice(0, 10);
  const hotspots = [
    ...new Set([
      ...crossUnitFiles.map((entry) => entry.file),
      ...contractFiles,
      ...fanIn.filter((entry) => entry.callers >= 2).map((entry) => entry.file),
    ]),
  ].filter((file) => (changedFiles || []).includes(file));
  return {
    owners: [...owners.entries()].map(([file, units]) => ({
      file,
      units: [...units].sort(),
    })),
    cross_unit_files: crossUnitFiles,
    contract_files: contractFiles,
    fan_in: fanIn,
    hotspots,
  };
}

function previousTaskReviews(worktree, runState, runId, headCommit) {
  if (!Array.isArray(runState.task_history)) return [];
  return runState.task_history.map((entry) => {
    const unit = String(entry?.id || "");
    const handoff = entry?.review_handoff || null;
    const reviewPackage = entry?.review_package || null;
    const criteria = Array.isArray(entry?.acceptance_criteria)
      ? entry.acceptance_criteria.map(String)
      : [];
    const packageCriteria = Array.isArray(reviewPackage?.acceptance_criteria)
      ? reviewPackage.acceptance_criteria.map(String)
      : [];
    const criteriaMatch =
      criteria.length === packageCriteria.length &&
      criteria.every((criterion, index) => criterion === packageCriteria[index]);
    const handoffBound = Boolean(
      handoff?.verdict === "APPROVED" &&
        handoff.review_scope === "task" &&
        handoff.run_id === runId &&
        (handoff.unit_or_task || handoff.task_id) === unit &&
        handoff.reviewed_commit === entry.reviewed_commit &&
        Array.isArray(handoff.acceptance) &&
        Array.isArray(handoff.checks),
    );
    const packageBound = Boolean(
      reviewPackage?.scope === "task" &&
        reviewPackage.run_id === runId &&
        reviewPackage.unit_or_task === unit &&
        reviewPackage.head_commit === entry.reviewed_commit &&
        /^[a-f0-9]{64}$/i.test(reviewPackage.digest_sha256 || "") &&
        criteriaMatch,
    );
    const changedAfterReview = filesChangedBetween(
      worktree,
      entry.reviewed_commit,
      headCommit,
    );
    return {
      unit_or_task: unit || null,
      verdict: entry.verdict || handoff?.verdict || null,
      review_scope: handoff?.review_scope || null,
      reviewed_commit: entry.reviewed_commit || null,
      review_package_digest_sha256: reviewPackage?.digest_sha256 || null,
      review_package_head_commit: reviewPackage?.head_commit || null,
      review_evidence_bound: handoffBound && packageBound,
      acceptance: Array.isArray(handoff?.acceptance) ? handoff.acceptance : [],
      checks: Array.isArray(handoff?.checks) ? handoff.checks : [],
      files_reviewed: Array.isArray(handoff?.files_reviewed)
        ? handoff.files_reviewed
        : [],
      files_changed_after_review: changedAfterReview,
    };
  });
}

/** Resolve package markdown path against worktree. */
export function resolveReviewPackagePath(pkg, worktree) {
  if (!pkg?.path) return null;
  if (path.isAbsolute(pkg.path)) return pkg.path;
  if (!worktree) return pkg.path;
  return path.join(worktree, pkg.path);
}

function normalizedRelativePath(value) {
  return typeof value === "string"
    ? value.replace(/\\/g, "/").replace(/^\.\//, "")
    : "";
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(
    relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
  );
}

function reviewPackageRelativePath(value, extension) {
  const normalized = normalizedRelativePath(value);
  if (!normalized || path.isAbsolute(value) || normalized !== value.replace(/\\/g, "/").replace(/^\.\//, "")) {
    return false;
  }
  if (normalized.startsWith("../") || normalized.includes("/../") || normalized.includes("\0")) {
    return false;
  }
  return (
    normalized.startsWith(".opencode/reviews/") &&
    normalized.endsWith(extension) &&
    normalized !== `.opencode/reviews/${extension}`
  );
}

function isCommitId(value) {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function requiredPackageIdentityErrors(pkg) {
  const errors = [];
  for (const field of [
    "schema_version",
    "scope",
    "run_id",
    "unit_or_task",
    "base_commit",
    "head_commit",
    "path",
    "absolute_path",
    "meta_path",
    "digest_sha256",
    "generated_at",
  ]) {
    if (typeof pkg?.[field] !== "string" || !pkg[field].trim()) {
      errors.push(`review_package.${field} required`);
    }
  }
  if (pkg?.ok !== true) errors.push("review_package.ok must be true");
  if (
    typeof pkg?.digest_sha256 === "string" &&
    !/^[a-f0-9]{64}$/i.test(pkg.digest_sha256)
  ) {
    errors.push("review_package.digest_sha256 must be a raw 64-character SHA-256 digest");
  }
  if (typeof pkg?.path === "string" && !reviewPackageRelativePath(pkg.path, ".md")) {
    errors.push("review_package.path must be a relative .opencode/reviews/*.md path");
  }
  if (typeof pkg?.meta_path === "string" && !reviewPackageRelativePath(pkg.meta_path, ".json")) {
    errors.push("review_package.meta_path must be a relative .opencode/reviews/*.json path");
  }
  if (
    typeof pkg?.generated_at === "string" &&
    Number.isNaN(Date.parse(pkg.generated_at))
  ) {
    errors.push("review_package.generated_at must be an ISO timestamp");
  }
  if (!Array.isArray(pkg?.changed_files)) {
    errors.push("review_package.changed_files must be an array");
  }
  if (!Array.isArray(pkg?.production_files)) {
    errors.push("review_package.production_files must be an array");
  }
  if (!Array.isArray(pkg?.acceptance_criteria)) {
    errors.push("review_package.acceptance_criteria must be an array");
  }
  return errors;
}

function comparePackageMetadata(pkg, metadata, errors) {
  if (!metadata || typeof metadata !== "object") {
    errors.push("review_package metadata sidecar is missing or invalid");
    return;
  }
  for (const field of [
    "schema_version",
    "ok",
    "scope",
    "run_id",
    "unit_or_task",
    "run_base_commit",
    "base_commit",
    "head_commit",
    "path",
    "absolute_path",
    "meta_path",
    "digest_sha256",
    "generated_at",
  ]) {
    if (metadata[field] !== pkg[field]) {
      errors.push(`review_package metadata ${field} does not match state pointer`);
    }
  }
  for (const field of ["changed_files", "production_files", "acceptance_criteria"]) {
    if (JSON.stringify(metadata[field] || []) !== JSON.stringify(pkg[field] || [])) {
      errors.push(`review_package metadata ${field} does not match state pointer`);
    }
  }
}

/**
 * Choose BASE for a review package.
 * - task: pre-task head (runState.head_commit)
 * - final: immutable run_base_commit (whole branch since run start)
 */
export function resolveReviewPackageBase(runState = {}, scope = "task", opts = {}) {
  if (opts.baseCommit) return opts.baseCommit;
  if (scope === "final") {
    return (
      runState.run_base_commit ||
      runState.plan_commit ||
      null
    );
  }
  return runState.head_commit || runState.plan_commit || null;
}

/**
 * @param {string} worktree
 * @param {object} opts
 */
export function buildReviewPackage(worktree, opts = {}) {
  const startedAt = Date.now();
  const root = path.resolve(worktree);
  const rootBoundary = validateContainedPath(root, root, {
    allowMissing: false,
    rejectSymlinks: true,
  });
  if (!rootBoundary.ok) {
    throw new Error(
      `review package worktree violates filesystem boundary (${rootBoundary.reason})`,
    );
  }
  const scope = opts.scope === "final" ? "final" : "task";
  const runState = opts.runState || {};
  const runId = runState.run_id || opts.run_id || "run";
  const unit =
    runState.current_unit || opts.unit_or_task || opts.unit || "task";

  const headCommit =
    opts.headCommit ||
    runState.implementer_commit ||
    revParse(worktree, "HEAD");

  let baseCommit = resolveReviewPackageBase(runState, scope, opts);
  if (!baseCommit && headCommit) {
    baseCommit = revParse(worktree, `${headCommit}^`) || headCommit;
  }

  const acceptance =
    opts.acceptanceCriteria ||
    (scope === "final" && Array.isArray(runState.task_history)
      ? runState.task_history.flatMap((t) => t.acceptance_criteria || [])
      : null) ||
    runState.acceptance_criteria ||
    [];
  const priorTaskReviews = scope === "final"
    ? previousTaskReviews(worktree, runState, runId, headCommit)
    : [];

  const nameStatus = runGit(worktree, [
    "diff",
    "--name-status",
    baseCommit,
    headCommit,
  ]);
  const changedFiles = [];
  if (nameStatus.ok && nameStatus.stdout.trim()) {
    for (const line of nameStatus.stdout.trim().split("\n")) {
      const parts = line.split(/\t/);
      const file = parts[parts.length - 1];
      if (file) changedFiles.push(file);
    }
  }

  const diffStat = runGit(worktree, ["diff", "--stat", baseCommit, headCommit]);
  const nameStatusText = nameStatus.ok ? nameStatus.stdout.trimEnd() : "";
  const fullDiffBytes = runGit(worktree, [
    "diff",
    "--find-renames",
    baseCommit,
    headCommit,
  ]);
  const wholeDiffBytes = fullDiffBytes.ok ? fullDiffBytes.stdout.length : null;

  const planPath = opts.planPath
    ? path.isAbsolute(opts.planPath)
      ? opts.planPath
      : path.resolve(root, opts.planPath)
    : path.join(root, ".opencode", "plans", "PLAN.md");
  const planBoundary = validateContainedPath(root, planPath, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  if (!planBoundary.ok) {
    throw new Error(
      `review package plan path violates filesystem boundary (${planBoundary.reason})`,
    );
  }
  const planSelection = currentUnitFromPlan(planPath, unit);

  const impact =
    opts.impact || runState.post_impact || runState.impact || null;
  const verification =
    opts.verification ||
    runState.provider_verification ||
    runState.final_verification ||
    null;
  const implementerNotes =
    runState.last_implementer_handoff?.notes_for_reviewer ||
    opts.implementer_notes ||
    "";

  const productionChanged = changedFiles.filter(isLikelyProductionPath);
  const ordering = reviewOrderedFiles(changedFiles);
  const impactSelected = impactSelection(impact, changedFiles);
  const sealedCommands = sealedCommandsFromVerification(verification);

  const ranges = scope === "final" ? unitChangeRanges(worktree, runState, headCommit) : [];
  const integration =
    scope === "final"
      ? integrationSelection(ranges, changedFiles, impactSelected)
      : null;

  // Selection: a task review is unit-focused (production first, then its tests);
  // a final review is integration-focused (shared surface and post-approval
  // changes first). Everything omitted is retrievable with a named command.
  const hunkFiles =
    scope === "final"
      ? [
          ...new Set([
            ...(integration?.hotspots || []),
            ...(ranges.at(-1)?.files || []).filter(isLikelyProductionPath),
          ]),
        ]
      : [...ordering.production, ...ordering.tests];
  const hunks = selectFocusedHunks(worktree, baseCommit, headCommit, hunkFiles, {
    maxBytes:
      opts.maxHunkBytes ||
      opts.maxDiffBytes ||
      (scope === "final" ? DEFAULT_FINAL_HUNK_BYTES : DEFAULT_TASK_HUNK_BYTES),
    maxPerFileBytes: opts.maxPerFileHunkBytes,
  });

  const inspectCommands = [
    "## Inspect anything else yourself (read-only)",
    "",
    "The package is a selection, not the whole truth. You have read-only git and",
    "file access; use it whenever a judgement needs more than what is quoted here.",
    "",
    "```bash",
    `git diff ${baseCommit} ${headCommit}                  # whole diff${
      wholeDiffBytes != null ? ` (${wholeDiffBytes} bytes)` : ""
    }`,
    `git diff ${baseCommit} ${headCommit} -- <path>        # one file`,
    `git log --oneline ${baseCommit}..${headCommit}        # commits under review`,
    `git show <commit>                                     # one commit`,
    "rg -n '<symbol>'                                      # callers and usages",
    "```",
    "",
  ];

  const generatedAt = new Date().toISOString();
  const identitySection = [
    `# Nexus Review Package (${scope})`,
    "",
    "> Generated deterministically by Nexus. Treat implementer notes as **unverified claims**.",
    "> There is **no expected verdict**. Try to disprove correctness.",
    "> Sealed deterministic verification is authoritative evidence: **consume it, do not replay it**.",
    "",
    "## Identity",
    "",
    `- run_id: \`${runId}\``,
    `- unit_or_task: \`${unit}\``,
    `- review_scope: \`${scope}\``,
    `- run_base_commit: \`${runState.run_base_commit || "(unset)"}\``,
    `- base_commit: \`${baseCommit}\``,
    `- head_commit: \`${headCommit}\``,
    `- generated_at: \`${generatedAt}\``,
    `- selection: \`${REVIEW_SELECTION_VERSION}\``,
    "",
  ];

  const acceptanceSection = [
    "## Acceptance criteria",
    "",
    Array.isArray(acceptance) && acceptance.length
      ? acceptance.map((c, i) => `AC-${i + 1}. ${c}`).join("\n")
      : "_No acceptance_criteria recorded on run state — derive from the execution unit below._",
    "",
  ];

  const unitSection =
    scope === "task"
      ? [
          "## Execution unit under review",
          "",
          planSelection?.unit
            ? [
                `- id: \`${planSelection.unit.id}\``,
                `- title: ${planSelection.unit.title || "(untitled)"}`,
                `- user_outcome: ${planSelection.unit.user_outcome || "(not stated)"}`,
                `- review_boundary: ${planSelection.unit.review_boundary || "(not stated)"}`,
                `- estimated_lines: ${planSelection.unit.estimated_lines ?? "(not stated)"}`,
                `- plan goal: ${planSelection.plan_goal || "(not stated)"}`,
                planSelection.plan_non_goals.length
                  ? `- plan non-goals: ${planSelection.plan_non_goals.join("; ")}`
                  : "- plan non-goals: (none stated)",
                planSelection.unit.allowed_files.length
                  ? `- declared scope: ${planSelection.unit.allowed_files.map((f) => `\`${f}\``).join(", ")}`
                  : "- declared scope: (not stated)",
                planSelection.unit.evidence.length
                  ? `- plan evidence: ${planSelection.unit.evidence.slice(0, 10).join("; ")}`
                  : "- plan evidence: (none stated)",
                planSelection.unit.stop_conditions.length
                  ? `- STOP conditions: ${planSelection.unit.stop_conditions.join("; ")}`
                  : "- STOP conditions: (none stated)",
                planSelection.unit.acceptance_criteria.length
                  ? `- plan acceptance criteria: ${planSelection.unit.acceptance_criteria.join("; ")}`
                  : "- plan acceptance criteria: (none stated)",
              ].join("\n")
            : `_No matching execution unit found in ${path.relative(root, planPath).split(path.sep).join("/")}; read the plan directly._`,
          "",
        ]
      : [
          "## Run objective",
          "",
          `- plan goal: ${planSelection?.plan_goal || "(not stated)"}`,
          planSelection?.plan_non_goals?.length
            ? `- plan non-goals: ${planSelection.plan_non_goals.join("; ")}`
            : "- plan non-goals: (none stated)",
          `- execution units in plan: ${planSelection?.unit_count ?? "unknown"}`,
          `- units with a recorded approval: ${priorTaskReviews.length}`,
          "",
        ];

  const finalSections =
    scope === "final"
      ? [
          "## Previous task review evidence (task approval summaries)",
          "",
          priorTaskReviews.length
            ? priorTaskReviews
                .map((review) =>
                  [
                    `- ${review.unit_or_task || "(unknown unit)"}: ${review.verdict || "NO_VERDICT"}` +
                      ` @ \`${review.reviewed_commit || "(no commit)"}\``,
                    `  - review_evidence_bound: ${review.review_evidence_bound}`,
                    `  - acceptance entries: ${review.acceptance.length}, checks: ${review.checks.length}, files_reviewed: ${review.files_reviewed.length}`,
                    `  - files_changed_after_review: ${
                      review.files_changed_after_review === null
                        ? "UNAVAILABLE (treat every criterion as reopened)"
                        : review.files_changed_after_review.length === 0
                          ? "none"
                          : review.files_changed_after_review.join(", ")
                    }`,
                  ].join("\n"),
                )
                .join("\n")
            : "_No prior task approvals are recorded._",
          "",
          "Reuse a prior result only when `review_evidence_bound: true`, the",
          "post-review file list is available, and none of the criterion's owning",
          "files appears in it. This never replaces this final review.",
          "",
          "## Cross-unit and shared files",
          "",
          integration?.cross_unit_files?.length
            ? integration.cross_unit_files
                .map((entry) => `- ${entry.file} ← ${entry.units.join(", ")}`)
                .join("\n")
            : "_No file was changed by more than one unit._",
          "",
          "## Public / shared contract changes",
          "",
          integration?.contract_files?.length
            ? integration.contract_files.map((file) => `- ${file}`).join("\n")
            : "_No shared contract surface changed._",
          "",
          "## Integration hotspots (review these interactions first)",
          "",
          integration?.hotspots?.length
            ? integration.hotspots.map((file) => `- ${file}`).join("\n")
            : "_No integration hotspot detected._",
          "",
          "## Per-unit change ranges",
          "",
          ranges.length
            ? ranges
                .map(
                  (range) =>
                    `- ${range.unit_or_task || "(unknown)"}: \`${range.base || "?"}\`..\`${range.head || "?"}\` → ${
                      range.files === null
                        ? "range unavailable"
                        : `${range.files.length} file(s)`
                    }`,
                )
                .join("\n")
            : "_No unit ranges available._",
          "",
        ]
      : [];

  const md = [
    ...identitySection,
    ...acceptanceSection,
    ...unitSection,
    ...finalSections,
    "## Changed files",
    "",
    nameStatusText
      ? ["```text", clamp(nameStatusText, 20_000, "name-status"), "```"].join("\n")
      : "_No changed files between base and head._",
    "",
    "## Diff stat",
    "",
    diffStat.ok && diffStat.stdout.trim()
      ? ["```text", clamp(diffStat.stdout.trimEnd(), DEFAULT_DIFF_STAT_BYTES, "diff stat"), "```"].join("\n")
      : "_No diff stat available._",
    "",
    "## Production files (must be reviewed or explicitly skipped)",
    "",
    productionChanged.length
      ? productionChanged.map((f) => `- ${f}`).join("\n")
      : "_None classified as production._",
    "",
    "## Impact evidence (callers and related tests)",
    "",
    summarizeImpactSelection(impactSelected),
    "",
    "## Sealed verification (authoritative, already executed)",
    "",
    summarizeSealedVerification(verification, sealedCommands),
    "",
    scope === "final"
      ? "## Focused integration hunks"
      : "## Focused hunks (changed production files, then their tests)",
    "",
    hunks.text || "_No focused hunks selected._",
    "",
    ...(hunks.omitted.length > 0 || hunks.clipped.length > 0
      ? [
          "### Not quoted here",
          "",
          ...hunks.clipped.map(
            (entry) =>
              `- ${entry.file}: clipped at the per-file budget (${entry.bytes} bytes total) — \`git diff ${baseCommit} ${headCommit} -- ${entry.file}\``,
          ),
          ...hunks.omitted.map(
            (entry) =>
              `- ${entry.file}: ${entry.reason} — \`git diff ${baseCommit} ${headCommit} -- ${entry.file}\``,
          ),
          "",
        ]
      : []),
    "## Implementer notes (unverified claims)",
    "",
    implementerNotes || "_None._",
    "",
    ...inspectCommands,
  ].join("\n");

  const reviewRoot = path.resolve(root, ".opencode", "reviews");
  const outDir = path.resolve(
    root,
    opts.outDir || path.join(".opencode", "reviews"),
  );
  if (outDir !== reviewRoot && !isContained(reviewRoot, outDir)) {
    throw new Error("review package output must remain inside .opencode/reviews");
  }
  for (const [label, candidate] of [
    ["review package root", reviewRoot],
    ["review package output", outDir],
  ]) {
    const boundary = validateContainedPath(root, candidate, {
      allowMissing: true,
      rejectSymlinks: true,
    });
    if (!boundary.ok) {
      throw new Error(`${label} violates filesystem boundary (${boundary.reason})`);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const slug = `${runId}-${unit}-${scope}`.replace(/[^A-Za-z0-9._-]+/g, "_");
  const mdName = `${slug}-review-package.md`;
  const jsonName = `${slug}-review-package.json`;
  const mdPath = path.join(outDir, mdName);
  const jsonPath = path.join(outDir, jsonName);
  for (const [label, candidate] of [
    ["review package markdown", mdPath],
    ["review package metadata", jsonPath],
  ]) {
    const boundary = validateContainedPath(root, candidate, {
      allowMissing: true,
      rejectSymlinks: true,
    });
    if (!boundary.ok) {
      throw new Error(`${label} violates filesystem boundary (${boundary.reason})`);
    }
  }
  fs.writeFileSync(mdPath, md, "utf8");

  const digest = createHash("sha256").update(md).digest("hex");
  const meta = {
    schema_version: "1.0",
    ok: true,
    scope,
    run_id: runId,
    unit_or_task: unit,
    run_base_commit: runState.run_base_commit || null,
    base_commit: baseCommit,
    head_commit: headCommit,
    path: path.relative(worktree, mdPath).split(path.sep).join("/"),
    absolute_path: mdPath,
    meta_path: path.relative(worktree, jsonPath).split(path.sep).join("/"),
    changed_files: changedFiles,
    production_files: productionChanged,
    acceptance_criteria: acceptance,
    previous_task_reviews: priorTaskReviews,
    // PR6: the sealed commands the reviewer must consume instead of replaying.
    sealed_commands: sealedCommands,
    selection: {
      version: REVIEW_SELECTION_VERSION,
      hunk_budget_bytes: hunks.budget,
      hunk_bytes: hunks.bytes,
      hunk_files_included: hunks.included,
      hunk_files_clipped: hunks.clipped.map((entry) => entry.file),
      hunk_files_omitted: hunks.omitted,
      whole_diff_bytes: wholeDiffBytes,
      integration:
        scope === "final"
          ? {
              cross_unit_files: integration?.cross_unit_files || [],
              contract_files: integration?.contract_files || [],
              hotspots: integration?.hotspots || [],
              unit_ranges: ranges.map((range) => ({
                unit_or_task: range.unit_or_task,
                base: range.base,
                head: range.head,
                file_count: range.files === null ? null : range.files.length,
              })),
            }
          : null,
    },
    package_bytes: Buffer.byteLength(md, "utf8"),
    generation_ms: Date.now() - startedAt,
    digest_sha256: digest,
    generated_at: generatedAt,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  // PR6.D: measure the briefing so a selection regression is observable.
  if (typeof opts.telemetry?.emit === "function") {
    opts.telemetry.emit({
      event: "review_package",
      run_id: runId,
      kind: scope,
      review_package_bytes: meta.package_bytes,
      review_package_generation_ms: meta.generation_ms,
      duration_ms: meta.generation_ms,
      bytes: meta.package_bytes,
    });
  }
  return meta;
}

// re-export for callers that imported from review-package
export { isLikelyProductionPath };

/**
 * Lightweight presence check (scope/path/commits).
 */
export function assertReviewPackagePresent(pkg, { scope, worktree } = {}) {
  const errors = [];
  if (!pkg || typeof pkg !== "object") {
    errors.push(
      `requires review_package (run: nexus review-package --scope ${scope || "task"})`,
    );
    return { ok: false, errors };
  }
  const want = scope === "final" ? "final" : scope === "task" ? "task" : null;
  if (want && pkg.scope !== want) {
    errors.push(`review_package.scope must be "${want}" (got ${pkg.scope})`);
  }
  if (!pkg.path || typeof pkg.path !== "string" || !pkg.path.trim()) {
    errors.push("review_package.path required");
  } else if (path.isAbsolute(pkg.path)) {
    errors.push("review_package.path must not be absolute");
  } else if (pkg.path.includes("\0") || pkg.path.includes("..")) {
    errors.push("review_package.path must not escape its review directory");
  } else if (worktree) {
    const relative = normalizedRelativePath(pkg.path);
    const root = path.resolve(worktree);
    const reviewRoot = path.resolve(root, ".opencode", "reviews");
    const full = path.resolve(root, relative);
    const rootBoundary = validateContainedPath(root, root, {
      allowMissing: false,
      rejectSymlinks: true,
    });
    const reviewRootBoundary = validateContainedPath(root, reviewRoot, {
      allowMissing: true,
      rejectSymlinks: true,
    });
    const fullBoundary = validateContainedPath(root, full, {
      allowMissing: false,
      rejectSymlinks: true,
    });
    if (
      !rootBoundary.ok ||
      !reviewRootBoundary.ok ||
      !fullBoundary.ok ||
      !reviewPackageRelativePath(relative, ".md") ||
      !isContained(reviewRoot, full)
    ) {
      errors.push("review_package.path must be inside .opencode/reviews");
    } else if (!fullBoundary.exists || !fs.existsSync(full)) {
      errors.push(`review_package file missing: ${pkg.path}`);
    }
  }
  if (!pkg.base_commit) errors.push("review_package.base_commit required");
  if (!pkg.head_commit) errors.push("review_package.head_commit required");
  return { ok: errors.length === 0, errors };
}

/**
 * Full binding + integrity check for an authoritative review package.
 */
export function assertReviewPackageBound(pkg, {
  scope,
  worktree,
  state = {},
  handoff = {},
} = {}) {
  const present = assertReviewPackagePresent(pkg, { scope, worktree });
  const errors = [...present.errors];
  if (!pkg || typeof pkg !== "object") {
    return { ok: false, errors };
  }

  errors.push(...requiredPackageIdentityErrors(pkg));

  const expectedUnit =
    state.current_unit || handoff.unit_or_task || handoff.task_id || null;
  if (!expectedUnit) {
    errors.push("review_package requires a state/handoff unit binding");
  } else if (pkg.unit_or_task !== expectedUnit) {
    errors.push(
      `review_package.unit_or_task mismatch (got ${pkg.unit_or_task || "missing"}, want ${expectedUnit})`,
    );
  }

  if (!state.run_id) {
    errors.push("review_package binding requires state.run_id");
  } else if (pkg.run_id !== state.run_id) {
    errors.push(
      `review_package.run_id mismatch (got ${pkg.run_id}, want ${state.run_id})`,
    );
  }

  const reviewed = handoff.reviewed_commit;
  if (!reviewed) {
    errors.push("review_package binding requires handoff.reviewed_commit");
  } else if (pkg.head_commit !== reviewed) {
    errors.push(
      `review_package.head_commit (${pkg.head_commit}) must equal reviewed_commit (${reviewed})`,
    );
  }

  const expectedBase =
    scope === "final"
      ? state.run_base_commit || null
      : state.head_commit || null;
  if (!expectedBase) {
    errors.push("review_package binding requires a base_commit anchor");
  } else if (pkg.base_commit !== expectedBase) {
    errors.push(
      `review_package.base_commit mismatch (got ${pkg.base_commit}, want ${expectedBase})`,
    );
  }
  if (scope === "final") {
    if (!state.run_base_commit) {
      errors.push("final review_package binding requires state.run_base_commit");
    } else if (pkg.run_base_commit !== state.run_base_commit) {
      errors.push(
        `final review_package.run_base_commit must equal state.run_base_commit (${state.run_base_commit})`,
      );
    }
  } else if (state.run_base_commit && pkg.run_base_commit !== state.run_base_commit) {
    errors.push(
      `review_package.run_base_commit must equal state.run_base_commit (${state.run_base_commit})`,
    );
  }

  if (!worktree || typeof worktree !== "string" || !worktree.trim()) {
    // In-memory callers can still prove the complete identity contract, but
    // on-disk path/content verification is performed whenever a worktree is
    // available (the CLI always supplies one).
    return { ok: errors.length === 0, errors };
  }

  for (const field of ["base_commit", "head_commit"]) {
    if (!isCommitId(pkg[field])) {
      errors.push(`review_package.${field} must be a full commit id when bound to a worktree`);
    }
  }
  if (scope === "final" && !isCommitId(pkg.run_base_commit)) {
    errors.push("review_package.run_base_commit must be a full commit id when bound to a worktree");
  }

  const root = path.resolve(worktree);
  const reviewRoot = path.resolve(root, ".opencode", "reviews");
  const relative = normalizedRelativePath(pkg.path);
  const metaRelative = normalizedRelativePath(pkg.meta_path);
  const full = path.resolve(root, relative);
  const metaFull = path.resolve(root, metaRelative);
  const rootBoundary = validateContainedPath(root, root, {
    allowMissing: false,
    rejectSymlinks: true,
  });
  if (!rootBoundary.ok) {
    errors.push(`review_package worktree violates filesystem boundary (${rootBoundary.reason})`);
    return { ok: false, errors };
  }
  const reviewRootBoundary = validateContainedPath(root, reviewRoot, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  if (!reviewRootBoundary.ok) {
    errors.push(
      `review_package review directory violates filesystem boundary (${reviewRootBoundary.reason})`,
    );
    return { ok: false, errors };
  }
  const fullBoundary = validateContainedPath(root, full, {
    allowMissing: false,
    rejectSymlinks: true,
  });
  const metaBoundary = validateContainedPath(root, metaFull, {
    allowMissing: false,
    rejectSymlinks: true,
  });
  if (
    !fullBoundary.ok ||
    !isContained(reviewRoot, full) ||
    !reviewPackageRelativePath(relative, ".md")
  ) {
    errors.push("review_package.path is outside the canonical .opencode/reviews directory");
    return { ok: false, errors };
  }
  if (
    !metaBoundary.ok ||
    !isContained(reviewRoot, metaFull) ||
    !reviewPackageRelativePath(metaRelative, ".json")
  ) {
    errors.push("review_package.meta_path is outside the canonical .opencode/reviews directory");
    return { ok: false, errors };
  }
  if (typeof pkg.absolute_path !== "string" || !pkg.absolute_path.trim()) {
    errors.push("review_package.absolute_path required");
  } else if (path.resolve(pkg.absolute_path) !== full) {
    errors.push("review_package.absolute_path does not match its canonical relative path");
  }
  if (path.basename(metaRelative, ".json") !== path.basename(relative, ".md")) {
    errors.push("review_package.meta_path does not match review_package.path");
  }
  if (!fullBoundary.exists || !fs.existsSync(full)) {
    errors.push(`review_package file missing: ${pkg.path}`);
  }
  if (!metaBoundary.exists || !fs.existsSync(metaFull)) {
    errors.push(`review_package metadata file missing: ${pkg.meta_path}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  let realReviewRoot;
  let realPackage;
  let realMeta;
  try {
    realReviewRoot = fs.realpathSync(reviewRoot);
    realPackage = fs.realpathSync(full);
    realMeta = fs.realpathSync(metaFull);
  } catch (error) {
    errors.push(`review_package path resolution failed: ${String(error?.message || error)}`);
    return { ok: false, errors };
  }
  if (!isContained(realReviewRoot, realPackage) || !isContained(realReviewRoot, realMeta)) {
    errors.push("review_package path is symlinked outside the canonical review directory");
  }

  try {
    const body = fs.readFileSync(full, "utf8");
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== pkg.digest_sha256) {
      errors.push(
        "review_package digest mismatch (file content does not match digest_sha256)",
      );
    }
    comparePackageMetadata(
      pkg,
      JSON.parse(fs.readFileSync(metaFull, "utf8")),
      errors,
    );
  } catch (error) {
    errors.push(`review_package integrity read failed: ${String(error?.message || error)}`);
  }

  const head = revParse(worktree, "HEAD");
  if (!head) {
    errors.push("review_package binding could not resolve current HEAD");
  } else if (pkg.head_commit !== head) {
    errors.push(
      `review_package.head_commit (${pkg.head_commit}) must match current HEAD (${head})`,
    );
  }
  const baseResolved = revParse(worktree, pkg.base_commit);
  const packageHeadResolved = revParse(worktree, pkg.head_commit);
  if (!baseResolved || !packageHeadResolved) {
    errors.push("review_package base_commit/head_commit must resolve to commits in the bound worktree");
  }
  const ancestor = runGit(worktree, [
    "merge-base",
    "--is-ancestor",
    pkg.base_commit,
    pkg.head_commit,
  ]);
  if (!ancestor.ok) {
    errors.push("review_package base_commit must be an ancestor of head_commit");
  }

  return { ok: errors.length === 0, errors };
}
