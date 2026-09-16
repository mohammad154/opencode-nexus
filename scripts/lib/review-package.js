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

function safeRead(filePath, max = 80_000) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf8");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…[truncated ${text.length - max} chars]…\n`;
}

function summarizeImpact(impact) {
  if (!impact || typeof impact !== "object") return "_No impact report attached._";
  const lines = [
    `- risk: ${impact.risk || impact.level || "UNKNOWN"}`,
    `- ok: ${impact.ok}`,
    `- confidence: ${impact.confidence ?? "n/a"}`,
    `- changed_files: ${(impact.changed_files || []).join(", ") || "(none)"}`,
    `- direct_dependents: ${JSON.stringify(impact.direct_dependents || []).slice(0, 2000)}`,
    `- related_tests: ${JSON.stringify(impact.related_tests || []).slice(0, 2000)}`,
  ];
  return lines.join("\n");
}

function summarizeVerification(v) {
  if (!v || typeof v !== "object") return "_No verification report attached._";
  const results = Array.isArray(v.results) ? v.results : [];
  const lines = [`- ok: ${v.ok}`, `- results: ${results.length}`];
  for (const step of results.slice(0, 30)) {
    lines.push(
      `  - ${step.id || step.command}: exit=${step.exit_code} pass=${step.pass}`,
    );
  }
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

  const fullDiff = runGit(worktree, [
    "diff",
    "--find-renames",
    baseCommit,
    headCommit,
  ]);
  let diffText = fullDiff.ok
    ? fullDiff.stdout
    : fullDiff.stderr || "(diff unavailable)";
  const maxDiff = opts.maxDiffBytes || 400_000;
  if (diffText.length > maxDiff) {
    diffText = `${diffText.slice(0, maxDiff)}\n\n…[diff truncated]…\n`;
  }

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
  const planExcerpt = safeRead(planPath, 20_000) || "_PLAN.md not found._";

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
  const generatedAt = new Date().toISOString();
  const md = [
    `# Nexus Review Package (${scope})`,
    "",
    "> Generated deterministically by Nexus. Treat implementer notes as **unverified claims**.",
    "> There is **no expected verdict**. Try to disprove correctness.",
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
    "",
    "## Acceptance criteria",
    "",
    Array.isArray(acceptance) && acceptance.length
      ? acceptance.map((c, i) => `${i + 1}. ${c}`).join("\n")
      : "_No acceptance_criteria recorded on run state — derive from PLAN.md / task brief._",
    "",
    "## Task / plan excerpt",
    "",
    planExcerpt,
    "",
    ...(scope === "final"
      ? [
          "## Previous task review evidence",
          "",
          priorTaskReviews.length
            ? ["```json", JSON.stringify(priorTaskReviews, null, 2), "```"].join("\n")
            : "_No prior task approvals are recorded._",
          "",
        ]
      : []),
    "## Changed files",
    "",
    changedFiles.length
      ? changedFiles.map((f) => `- ${f}`).join("\n")
      : "_No changed files between base and head._",
    "",
    "## Production files (must be reviewed or explicitly skipped)",
    "",
    productionChanged.length
      ? productionChanged.map((f) => `- ${f}`).join("\n")
      : "_None classified as production._",
    "",
    "## Impact evidence",
    "",
    summarizeImpact(impact),
    "",
    "## Verification results (deterministic)",
    "",
    summarizeVerification(verification),
    "",
    "## Implementer notes (unverified claims)",
    "",
    implementerNotes || "_None._",
    "",
    "## Diff (BASE..HEAD)",
    "",
    "```diff",
    diffText.trimEnd() || "(empty diff)",
    "```",
    "",
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
    digest_sha256: digest,
    generated_at: generatedAt,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
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
