import fs from "fs";
import path from "path";
import { validateHandoff, validateRunState } from "./schema-validate.js";

const RUN_STATE_VERSION = "1.0";
const HANDOFF_VERSION = "1.0";
const LEGACY_HANDOFF = "0.9";

function nowIso() {
  return new Date().toISOString();
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Normalize legacy (0.9 / missing schema_version) handoffs to 1.0 in memory.
 * Does not write disk unless caller uses write flag elsewhere.
 */
export function normalizeHandoff(role, raw) {
  const data = deepClone(raw && typeof raw === "object" ? raw : {});
  const migrated_from = data.schema_version || LEGACY_HANDOFF;

  if (!data.schema_version || data.schema_version === LEGACY_HANDOFF) {
    data.schema_version = HANDOFF_VERSION;
  }

  if (role === "implementer") {
    if (!Array.isArray(data.files_changed))
      data.files_changed = data.files_changed
        ? [String(data.files_changed)]
        : [];
    if (!Array.isArray(data.tests))
      data.tests = data.tests ? [].concat(data.tests) : [];
    if (!Array.isArray(data.tasks_completed)) data.tasks_completed = [];
    if (!Array.isArray(data.scope_extras)) data.scope_extras = [];
    if (!Array.isArray(data.verification_gates)) data.verification_gates = [];
    if (!data.drift_check || typeof data.drift_check !== "object") {
      data.drift_check = {
        plan_commit: data.plan_commit ?? null,
        current_head: data.commit ?? null,
        pass: null,
      };
    }
    if (!data.blast || typeof data.blast !== "object") {
      data.blast = {
        risk: "UNKNOWN",
        verified: data.blast_verified ?? null,
        callers_checked: [],
      };
    }
    if (data.notes_for_reviewer == null) data.notes_for_reviewer = "";
  }

  if (
    role === "unified-reviewer" ||
    role === "spec-reviewer" ||
    role === "code-reviewer"
  ) {
    if (!data.blast || typeof data.blast !== "object") {
      data.blast = { pass: null, risk: "UNKNOWN" };
    } else if (!("pass" in data.blast) && data.blast.pass !== false) {
      if (data.blast.pass === undefined) data.blast.pass = null;
      if (!data.blast.risk) data.blast.risk = "UNKNOWN";
    }
    if (!Array.isArray(data.findings)) data.findings = [];
    if (
      (role === "unified-reviewer" || role === "spec-reviewer") &&
      !Array.isArray(data.acceptance)
    ) {
      data.acceptance = [];
    }
  }

  return { data, migrated_from };
}

export function normalizeAndValidateHandoff(role, raw) {
  const { data, migrated_from } = normalizeHandoff(role, raw);
  const result = validateHandoff(role, data);
  return { ...result, data, migrated_from };
}

export function runsDir(worktree) {
  return path.join(worktree, ".opencode", "runs");
}

export function runStatePath(worktree, runId) {
  return path.join(runsDir(worktree), runId, "state.json");
}

export function createEmptyRunState(runId, overrides = {}) {
  const t = nowIso();
  return {
    schema_version: RUN_STATE_VERSION,
    run_id: runId,
    state: "CREATED",
    profile: "balanced",
    review_level: "unified",
    execution_mode: "delegated",
    current_unit: null,
    classification: null,
    plan_commit: null,
    branch: null,
    graph: null,
    blast: null,
    block_reason: null,
    block_code: null,
    transitions: [],
    created_at: t,
    updated_at: t,
    ...overrides,
  };
}

export function readRunState(worktree, runId) {
  const p = runStatePath(worktree, runId);
  if (!fs.existsSync(p)) return null;
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  const v = validateRunState(data);
  if (!v.ok) {
    const err = new Error(
      `invalid run state: ${v.errors.map((e) => e.message).join("; ")}`,
    );
    err.validation = v;
    throw err;
  }
  return data;
}

export function writeRunState(worktree, state) {
  const v = validateRunState(state);
  if (!v.ok) {
    const err = new Error(
      `cannot write invalid run state: ${v.errors.map((e) => e.message).join("; ")}`,
    );
    err.validation = v;
    throw err;
  }
  const dir = path.join(runsDir(worktree), state.run_id);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "state.json");
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const next = { ...state, updated_at: nowIso() };
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, target);
  return next;
}

function parseContextYamlish(text) {
  const out = {};
  if (!text) return out;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Build a synthetic run state from CONTEXT.md + handoffs when .opencode/runs/ is missing.
 * Never invents APPROVED verdicts.
 */
export function inferRunFromContext(worktree) {
  const contextPath = path.join(worktree, ".opencode", "CONTEXT.md");
  const ctxText = fs.existsSync(contextPath)
    ? fs.readFileSync(contextPath, "utf8")
    : "";
  const fields = parseContextYamlish(ctxText);
  const runId = fields.run_id || `inferred-${Date.now()}`;
  const profile = ["fast", "balanced", "strict"].includes(
    fields.workflow_profile,
  )
    ? fields.workflow_profile
    : "balanced";

  let state = "CREATED";
  if (fields.workflow_profile || fields.change_class) state = "CLASSIFIED";

  const handoffsDir = path.join(worktree, ".opencode", "handoffs");
  let latestImplementer = null;
  let latestReview = null;
  if (fs.existsSync(handoffsDir)) {
    for (const f of fs.readdirSync(handoffsDir)) {
      if (!f.endsWith(".json")) continue;
      const full = path.join(handoffsDir, f);
      try {
        const raw = JSON.parse(fs.readFileSync(full, "utf8"));
        if (f.includes("implementer")) latestImplementer = raw;
        if (f.includes("reviewer")) latestReview = raw;
      } catch {
        /* ignore corrupt */
      }
    }
  }

  if (
    latestImplementer &&
    ["DONE", "DONE_WITH_CONCERNS"].includes(latestImplementer.status)
  ) {
    state = "VERIFYING";
  }
  if (latestReview && latestReview.verdict) {
    state = latestReview.verdict === "APPROVED" ? "REVIEWING" : "REVIEWING";
  }

  return createEmptyRunState(runId, {
    state,
    profile,
    plan_commit: fields.plan_commit || null,
    branch: fields.feature_branch || fields.branch || null,
    current_unit: fields.current_unit || null,
    classification: fields.workflow_profile
      ? {
          schema_version: "1.0",
          profile,
          risk_score: 0,
          confidence: 0.5,
          reasons: ["inferred from CONTEXT.md"],
          inferred: true,
        }
      : null,
    _inferred: true,
  });
}

export function listRunIds(worktree) {
  const dir = runsDir(worktree);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => fs.existsSync(runStatePath(worktree, id)));
}

export function latestRunState(worktree) {
  const ids = listRunIds(worktree);
  if (ids.length === 0) return null;
  let best = null;
  for (const id of ids) {
    const s = readRunState(worktree, id);
    if (!best || (s.updated_at || "") > (best.updated_at || "")) best = s;
  }
  return best;
}

export { RUN_STATE_VERSION, HANDOFF_VERSION, LEGACY_HANDOFF };
