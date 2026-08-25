/**
 * Deterministic Review Package — prepared before reviewer dispatch.
 * Scripts measure; the reviewer treats implementer claims as unverified.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

function runGit(worktree, args) {
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
  };
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

/**
 * @param {string} worktree
 * @param {object} opts
 * @param {"task"|"final"} opts.scope
 * @param {object} [opts.runState]
 * @param {string} [opts.baseCommit]
 * @param {string} [opts.headCommit]
 * @param {string[]} [opts.acceptanceCriteria]
 * @param {string} [opts.outDir]
 * @param {string} [opts.planPath]
 */
export function buildReviewPackage(worktree, opts = {}) {
  const scope = opts.scope === "final" ? "final" : "task";
  const runState = opts.runState || {};
  const runId = runState.run_id || opts.run_id || "run";
  const unit =
    runState.current_unit || opts.unit_or_task || opts.unit || "task";

  const headCommit =
    opts.headCommit ||
    runState.implementer_commit ||
    revParse(worktree, "HEAD");
  const baseCommit =
    opts.baseCommit ||
    runState.head_commit ||
    runState.plan_commit ||
    (headCommit ? revParse(worktree, `${headCommit}^`) : null) ||
    headCommit;

  const acceptance =
    opts.acceptanceCriteria ||
    runState.acceptance_criteria ||
    [];

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
  let diffText = fullDiff.ok ? fullDiff.stdout : fullDiff.stderr || "(diff unavailable)";
  const maxDiff = opts.maxDiffBytes || 400_000;
  if (diffText.length > maxDiff) {
    diffText = `${diffText.slice(0, maxDiff)}\n\n…[diff truncated]…\n`;
  }

  const planPath =
    opts.planPath || path.join(worktree, ".opencode", "plans", "PLAN.md");
  const planExcerpt = safeRead(planPath, 20_000) || "_PLAN.md not found._";

  const impact =
    opts.impact ||
    runState.post_impact ||
    runState.impact ||
    null;
  const verification =
    opts.verification ||
    runState.provider_verification ||
    runState.final_verification ||
    null;
  const implementerNotes =
    runState.last_implementer_handoff?.notes_for_reviewer ||
    opts.implementer_notes ||
    "";

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
    "## Changed files",
    "",
    changedFiles.length
      ? changedFiles.map((f) => `- ${f}`).join("\n")
      : "_No changed files between base and head._",
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

  const outDir =
    opts.outDir || path.join(worktree, ".opencode", "reviews");
  fs.mkdirSync(outDir, { recursive: true });
  const slug = `${runId}-${unit}-${scope}`.replace(/[^A-Za-z0-9._-]+/g, "_");
  const mdName = `${slug}-review-package.md`;
  const jsonName = `${slug}-review-package.json`;
  const mdPath = path.join(outDir, mdName);
  const jsonPath = path.join(outDir, jsonName);
  fs.writeFileSync(mdPath, md, "utf8");

  const digest = createHash("sha256").update(md).digest("hex");
  const meta = {
    schema_version: "1.0",
    ok: true,
    scope,
    run_id: runId,
    unit_or_task: unit,
    base_commit: baseCommit,
    head_commit: headCommit,
    path: path.relative(worktree, mdPath).split(path.sep).join("/"),
    absolute_path: mdPath,
    meta_path: path.relative(worktree, jsonPath).split(path.sep).join("/"),
    changed_files: changedFiles,
    acceptance_criteria: acceptance,
    digest_sha256: digest,
    generated_at: generatedAt,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}

/**
 * Validate review package meta for state-machine gates.
 * @returns {{ ok: boolean, errors: string[] }}
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
  } else if (worktree) {
    const full = path.isAbsolute(pkg.path)
      ? pkg.path
      : path.join(worktree, pkg.path);
    if (!fs.existsSync(full)) {
      errors.push(`review_package file missing: ${pkg.path}`);
    }
  }
  if (!pkg.base_commit) errors.push("review_package.base_commit required");
  if (!pkg.head_commit) errors.push("review_package.head_commit required");
  return { ok: errors.length === 0, errors };
}
