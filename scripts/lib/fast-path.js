/**
 * Direct execution for compact, git-less, or test-less tasks.
 *
 * Planning depth (`compact` / `standard` / `deep`) is unchanged. This module
 * chooses the execution pipeline. A repository with history and tests stays
 * on the standard pipeline until size, risk, or a safety signal is known.
 * Git-less and test-less workspaces may start direct and escalate later.
 * Set NEXUS_FAST_PATH=0 or workflow.fastPath=false to keep the full pipeline.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  COMPACT_MAX_FILES,
  COMPACT_MAX_LINES,
  compactEligibility,
  detectPlanningSignals,
  inferPlanningMode,
  normalizePlanningMode,
  planAdvisorDecision,
} from "./planning.js";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../config/default-workflow.json", import.meta.url),
);

const HARD_PIPELINE_SIGNALS = Object.freeze([
  "PUBLIC_CONTRACT",
  "SECURITY_BOUNDARY",
  "MIGRATION",
  "DESTRUCTIVE_CHANGE",
  "ARCHITECTURAL_CHOICE",
  "MULTI_SUBSYSTEM",
  "HIGH_IMPACT",
  "UNKNOWN_IMPACT",
]);

export const DIRECT_EDIT_LINE_LIMIT = 20;

function numericOrLength(value) {
  return Array.isArray(value) ? value.length : Number(value);
}

function planningSizes(input) {
  return {
    files: numericOrLength(
      input.files_changed ?? input.filesChanged ?? input.file_count ?? input.fileCount,
    ),
    lines: numericOrLength(
      input.estimated_lines ?? input.estimatedLines ?? input.lines,
    ),
    units: numericOrLength(
      input.unit_count ?? input.unitCount ?? input.execution_units ?? input.tasks ?? input.units,
    ),
  };
}

function planningRisk(input) {
  return String(input.risk || input.impact_risk || input.blastRisk || input.blast_risk || "")
    .trim()
    .toUpperCase();
}

export function loadFastPathConfig(workflow) {
  if (workflow && typeof workflow === "object") return workflow;
  try {
    return JSON.parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function fastPathEnabled(options = {}) {
  if (options.enabled === false) return false;
  const env = options.env || process.env;
  const flag = String(env.NEXUS_FAST_PATH ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  const workflow = loadFastPathConfig(options.workflow);
  if (workflow.fastPath === false) return false;
  return true;
}

function explicitPlanningMode(input) {
  const raw = input.planning_mode ?? input.planningMode;
  if (raw == null || String(raw).trim() === "") return null;
  return normalizePlanningMode(raw);
}

function flagFalse(input, keys) {
  return keys.some((key) => input[key] === false);
}

export function buildSessionPlan(input = {}) {
  const goal = String(
    input.objective || input.summary || input.goal || "Complete the user request.",
  )
    .trim()
    .replace(/\s+/g, " ");
  const files = Array.isArray(input.files_changed)
    ? input.files_changed.join(", ")
    : input.files || "only the files the request names";
  const check = input.check || input.test_command || "the discovered project check";
  return [
    `Goal: ${goal}`,
    "Non-goals: unrelated refactors, new features, and drive-by cleanup.",
    `Files: ${files}`,
    `Check: ${check}`,
    "Stop: escalate to the standard pipeline if the change exceeds 5 files, 150 lines, or a safety boundary.",
  ].join("\n");
}

function gitOk(cwd, args) {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    return {
      ok: result.status === 0 && !result.error,
      stdout: String(result.stdout || "").trim(),
    };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * Cheap workspace facts. Absence is explicit false; a probe failure is false
 * rather than an invented history or test suite.
 */
export function probeWorkspace(root) {
  const cwd = root ? path.resolve(root) : process.cwd();
  const inside = gitOk(cwd, ["rev-parse", "--is-inside-work-tree"]);
  let repoHistory = false;
  let existingGit = false;
  if (inside.ok && inside.stdout === "true") {
    const count = gitOk(cwd, ["rev-list", "--count", "HEAD"]);
    const subject = gitOk(cwd, ["log", "-1", "--format=%s"]);
    const commits = Number(count.stdout);
    const baselineOnly =
      count.ok && commits === 1 && subject.stdout === "nexus-baseline";
    repoHistory = count.ok && commits > 0 && !baselineOnly;
    existingGit = !baselineOnly;
  }
  return {
    repo_history: repoHistory,
    existing_git: existingGit,
    test_suite: workspaceHasTestSuite(cwd),
  };
}

function fileExists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

export function workspaceHasTestSuite(root) {
  const cwd = path.resolve(root);
  const packageJson = path.join(cwd, "package.json");
  if (fileExists(packageJson)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8"));
      const test = String(pkg?.scripts?.test || "");
      if (test && !/no test specified|echo error/i.test(test)) return true;
    } catch {
      // Unreadable package.json is not a test suite.
    }
  }
  const markers = [
    "pytest.ini",
    "tox.ini",
    "phpunit.xml",
    "phpunit.xml.dist",
    "go.mod",
    "Cargo.toml",
    path.join("tests"),
    path.join("test"),
    path.join("__tests__"),
    path.join("spec"),
  ];
  if (markers.some((marker) => fileExists(path.join(cwd, marker)))) return true;
  if (fileExists(path.join(cwd, "pyproject.toml"))) {
    try {
      const text = fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf8");
      if (/pytest|unittest/i.test(text)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function workspaceFact(input, options, key) {
  if (flagFalse(input, [key, `has_${key}`])) return false;
  if (input[key] === true || input[`has_${key}`] === true) return true;
  if (key === "repo_history" && input.no_repo_history === true) return false;
  if (key === "test_suite" && input.no_test_suite === true) return false;
  const workspace = options.workspace;
  if (workspace && workspace[key] === false) return false;
  if (workspace && workspace[key] === true) return true;
  return null;
}

/**
 * @returns {object} execution decision. `mode` is `direct` or `standard`.
 */
export function selectFastPath(input = {}, options = {}) {
  const enabled = fastPathEnabled(options);
  const signals = detectPlanningSignals(input);
  const hard = signals.filter((signal) => HARD_PIPELINE_SIGNALS.includes(signal));
  const sizes = planningSizes(input);
  const risk = planningRisk(input);
  const compact = compactEligibility({ ...input, planning_mode: undefined, planningMode: undefined });
  const explicit = explicitPlanningMode(input);
  const oversize =
    (Number.isFinite(sizes.files) && sizes.files > COMPACT_MAX_FILES) ||
    (Number.isFinite(sizes.lines) && sizes.lines > COMPACT_MAX_LINES) ||
    (Number.isFinite(sizes.units) && sizes.units > 1);
  const highRisk = risk === "HIGH" || risk === "CRITICAL" || risk === "UNKNOWN";
  const hasSize =
    Number.isFinite(sizes.files) || Number.isFinite(sizes.lines) || Number.isFinite(sizes.units);
  const history = workspaceFact(input, options, "repo_history");
  const existingGit = workspaceFact(input, options, "existing_git");
  const tests = workspaceFact(input, options, "test_suite");
  const noHistory = history === false;
  const noTests = tests === false;
  const unclassified = !hasSize && !risk && signals.length === 0 && explicit == null;
  const reasons = [];
  let mode = "standard";

  if (!enabled) {
    mode = "standard";
    reasons.push("FAST_PATH_DISABLED");
  } else if (
    input.execution_mode === "standard" ||
    input.execution_mode === "delegated" ||
    input.force_standard === true
  ) {
    mode = "standard";
    reasons.push("EXPLICIT_STANDARD");
  } else if (explicit === "deep" || hard.length > 0) {
    mode = "standard";
    reasons.push("ESCALATE_SIGNAL", ...(explicit === "deep" ? ["EXPLICIT_DEEP"] : []), ...hard);
  } else if (highRisk) {
    mode = "standard";
    reasons.push("ESCALATE_RISK");
  } else if (oversize) {
    mode = "standard";
    reasons.push("EVIDENCE_OF_SIZE");
  } else if (existingGit === true) {
    mode = "standard";
    reasons.push("EXISTING_GIT_REPOSITORY");
  } else if (history === true) {
    mode = "standard";
    reasons.push("EXISTING_REPO_HISTORY");
  } else if (compact.eligible) {
    mode = "direct";
    reasons.push("COMPACT_ELIGIBLE", ...compact.reason_codes);
  } else if (noHistory) {
    mode = "direct";
    reasons.push("NO_REPO_HISTORY");
  } else if (noTests) {
    mode = "direct";
    reasons.push("NO_TEST_SUITE");
  } else if (unclassified) {
    mode = "standard";
    reasons.push("UNCLASSIFIED_REQUIRES_STANDARD");
  } else if (explicit === "standard") {
    mode = "standard";
    reasons.push("EXPLICIT_STANDARD_KEPT");
  } else {
    mode = "standard";
    reasons.push("EVIDENCE_OF_SIZE_OR_RISK");
  }

  const advisorInput = { ...input };
  if (mode === "direct") {
    advisorInput.planning_mode = "compact";
  }
  const advisor = planAdvisorDecision(advisorInput);
  const workflow = loadFastPathConfig(options.workflow);
  const direct = mode === "direct";
  return {
    enabled,
    mode,
    planning_mode: direct ? "compact" : inferPlanningMode(input),
    plan_file: !direct,
    plan_advisor: direct ? false : advisor.required,
    advisor_parallel:
      workflow.advisorParallel !== false &&
      !direct &&
      advisor.required &&
      hard.length === 0 &&
      explicit !== "deep",
    repo_history: history,
    existing_git: existingGit,
    test_suite: tests,
    worktree: !direct,
    branch: !direct,
    reviewer: direct ? "on-second-failure-or-high" : "always",
    orchestrator_edit_lines: direct ? DIRECT_EDIT_LINE_LIMIT : 0,
    reasons,
    signals,
    session_plan: direct ? buildSessionPlan(input) : null,
    risk: risk || null,
  };
}

export function isDirectFastPath(state) {
  return state?.fast_path?.mode === "direct" && state?.fast_path?.enabled !== false;
}

export function directReviewRequired(state = {}, ctx = {}) {
  if (!isDirectFastPath(state)) return true;
  const policy = state.fast_path?.reviewer || "on-second-failure-or-high";
  if (policy === "always") return true;
  if (policy === "skip") return false;
  const risk = String(
    ctx.risk || state.impact?.risk || state.fast_path?.risk || "",
  ).toUpperCase();
  if (risk === "HIGH" || risk === "CRITICAL") return true;
  const failures = Number(state.fast_path?.check_failures ?? state.check_failures ?? 0);
  return Number.isFinite(failures) && failures >= 2;
}

export function sessionPlanLines(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function safeAllowedFiles(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((file) => {
    if (typeof file !== "string" || !file.trim()) return false;
    const parts = file.replace(/\\/g, "/").split("/");
    return !parts.includes("..");
  });
}

const CONTEXT_KEYS = [
  "security_boundary",
  "securitySensitive",
  "public_api",
  "publicApi",
  "databaseMigration",
  "database_migration",
  "destructive_change",
  "credentialHandling",
  "signals",
  "semantic_signals",
  "planning_mode",
  "planningMode",
  "force_standard",
  "execution_mode",
];

/** Size, risk, and safety flags the orchestrator can present mid-run. */
export function fastPathInputFromContext(state = {}, ctx = {}) {
  const input = {};
  const allowed = ctx.allowed_files || state.allowed_files;
  if (Array.isArray(allowed)) input.files_changed = allowed.length;
  const files = ctx.files_changed ?? ctx.filesChanged ?? ctx.file_count;
  if (files != null) input.files_changed = files;
  const lines = ctx.estimated_lines ?? ctx.estimatedLines ?? ctx.lines;
  if (lines != null) input.estimated_lines = lines;
  const units = ctx.unit_count ?? ctx.execution_units ?? ctx.units;
  if (units != null) input.unit_count = Array.isArray(units) ? units.length : units;
  const risk = ctx.risk || ctx.impact_risk || ctx.impact?.risk || state.impact?.risk || state.fast_path?.risk;
  if (risk) input.risk = risk;
  for (const key of CONTEXT_KEYS) {
    if (ctx[key] != null) input[key] = ctx[key];
  }
  return input;
}

export function fastPathWorkspaceFromState(state = {}) {
  return {
    repo_history: state.fast_path?.repo_history ?? null,
    test_suite: state.fast_path?.test_suite ?? null,
  };
}

/**
 * Record a direct-mode check failure or a measured impact risk.
 * `check_failures` is what makes the second failure dispatch a reviewer.
 */
export function noteDirectVerification(state = {}, { failed = false, risk = null } = {}) {
  if (!isDirectFastPath(state)) return state;
  const fast = { ...(state.fast_path || {}) };
  if (failed) fast.check_failures = (Number(fast.check_failures) || 0) + 1;
  if (risk) fast.risk = String(risk).trim().toUpperCase();
  const next = { ...state, fast_path: fast };
  if (risk) next.impact = { ...(state.impact || {}), risk: fast.risk };
  return next;
}

const ESCALATION_REASONS = new Set([
  "FAST_PATH_DISABLED",
  "EXPLICIT_STANDARD",
  "ESCALATE_SIGNAL",
  "EXPLICIT_DEEP",
  "ESCALATE_RISK",
  "EVIDENCE_OF_SIZE",
]);

/**
 * Re-classify a direct run. Only positive evidence of size, risk, or a safety
 * signal escalates. Missing facts do not.
 */
export function escalationDecision(state = {}, ctx = {}, options = {}) {
  if (!isDirectFastPath(state)) return null;
  const decision = selectFastPath(fastPathInputFromContext(state, ctx), {
    workspace: options.workspace || fastPathWorkspaceFromState(state),
    env: options.env,
    workflow: options.workflow,
    enabled: options.enabled,
  });
  if (decision.mode !== "standard") return null;
  if (!decision.reasons.some((reason) => ESCALATION_REASONS.has(reason))) return null;
  return decision;
}

/** Evidence for BRAINSTORMING → IMPLEMENTING on the direct path. */
export function directImplementErrors(state = {}, ctx = {}) {
  const errors = [];
  const escalation = escalationDecision(state, ctx);
  if (escalation) {
    return [
      `direct IMPLEMENTING refused (${escalation.reasons.join(", ")}). Escalate to the standard pipeline.`,
    ];
  }
  const lines = sessionPlanLines(ctx.session_plan || ctx.sessionPlan || state.fast_path?.session_plan);
  if (lines.length < 1 || lines.length > 8) {
    errors.push(
      "direct IMPLEMENTING requires a session_plan of 1 to 8 lines and does not read PLAN.md",
    );
  }
  const allowed = safeAllowedFiles(ctx.allowed_files || state.allowed_files);
  if (allowed.length === 0) {
    errors.push("direct IMPLEMENTING requires non-empty allowed_files inside the worktree");
  }
  const criteria = ctx.acceptance_criteria || ctx.acceptanceCriteria || state.acceptance_criteria;
  const list = Array.isArray(criteria)
    ? criteria.filter((item) => String(item || "").trim())
    : typeof criteria === "string" && criteria.trim()
      ? [criteria.trim()]
      : [];
  if (list.length === 0) {
    errors.push("direct IMPLEMENTING requires acceptance criteria");
  }
  return errors;
}
