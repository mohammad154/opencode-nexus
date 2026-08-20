import fs from "fs";
import path from "path";
import { validateHandoff, validateRunState } from "./schema-validate.js";
import { assertValidRunId } from "./policy.js";
import { withFileLock } from "./lock.js";

const RUN_STATE_VERSION = "1.0";
const HANDOFF_VERSION = "1.1";
const LEGACY_HANDOFF = "0.9";
const LEGACY_HANDOFF_VERSIONS = new Set(["0.9", "1.0", LEGACY_HANDOFF]);

function nowIso() {
  return new Date().toISOString();
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function isLegacyHandoffVersion(version) {
  return !version || LEGACY_HANDOFF_VERSIONS.has(version);
}

/**
 * Normalize legacy (0.9 / 1.0 / missing schema_version) handoffs to 1.1 in memory.
 * Does not write disk unless caller uses write flag elsewhere.
 * Legacy migrations are marked legacy_unverified and cannot satisfy COMPLETED
 * without an explicit administrative override.
 * Never invents commit bindings, verification pass results, or approvals.
 */
export function normalizeHandoff(role, raw) {
  const data = deepClone(raw && typeof raw === "object" ? raw : {});
  const migrated_from = raw?.schema_version || LEGACY_HANDOFF;
  const wasLegacy = isLegacyHandoffVersion(raw?.schema_version);

  if (wasLegacy || data.schema_version !== HANDOFF_VERSION) {
    data.schema_version = HANDOFF_VERSION;
  }

  // Envelope defaults for schema readability only — never invent commit hashes
  // or approval/verification outcomes.
  if (data.run_id == null || data.run_id === "") {
    data.run_id = wasLegacy ? "legacy-unbound" : data.run_id;
  }
  if (!data.unit_or_task) {
    data.unit_or_task =
      data.task_id || (wasLegacy ? "legacy-unbound" : data.unit_or_task);
  }
  if (!data.agent) data.agent = role;
  if (!("base_commit" in data)) data.base_commit = null;
  if (!data.created_at) data.created_at = nowIso();

  // Implementers must never self-exempt verification.
  if ("verification_exempt" in data) delete data.verification_exempt;

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
        // pass stays null — migration must not invent a passing drift check
        pass: null,
      };
    }
    if (!("commit" in data)) data.commit = null;
    if (!data.blast || typeof data.blast !== "object") {
      data.blast = {
        risk: "UNKNOWN",
        verified: data.blast_verified ?? null,
        callers_checked: [],
      };
    }
    if (data.notes_for_reviewer == null) data.notes_for_reviewer = "";
  }

  const isReviewerRole =
    role === "reviewer" ||
    role === "unified-reviewer" ||
    role === "spec-reviewer" ||
    role === "code-reviewer" ||
    role === "integration-reviewer";
  if (isReviewerRole) {
    const legacyReviewAgents = new Set([
      "unified-reviewer",
      "spec-reviewer",
      "code-reviewer",
      "integration-reviewer",
    ]);
    if (!data.agent || legacyReviewAgents.has(data.agent)) {
      data.agent = "reviewer";
    }
    if (!("reviewed_commit" in data)) data.reviewed_commit = null;
    if (!data.impact || typeof data.impact !== "object") {
      data.impact = data.blast && typeof data.blast === "object"
        ? { pass: data.blast.pass ?? null, risk: data.blast.risk || "UNKNOWN" }
        : { pass: null, risk: "UNKNOWN" };
    }
    if (!Array.isArray(data.findings)) data.findings = [];
    if (!Array.isArray(data.acceptance)) data.acceptance = [];
  }

  if (wasLegacy) {
    data.legacy_unverified = true;
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
  assertValidRunId(runId);
  const base = path.resolve(runsDir(worktree));
  const full = path.resolve(base, runId, "state.json");
  if (
    !full.startsWith(base + path.sep) &&
    full !== path.join(base, "state.json")
  ) {
    // Ensure resolved path stays under runsDir
    if (!full.startsWith(base)) {
      throw new Error(`run_id escapes runs directory: ${runId}`);
    }
  }
  const runDir = path.resolve(base, runId);
  if (!runDir.startsWith(base + path.sep) && runDir !== base) {
    throw new Error(`run_id escapes runs directory: ${runId}`);
  }
  return full;
}

export function createEmptyRunState(runId, overrides = {}) {
  assertValidRunId(runId);
  const t = nowIso();
  return {
    schema_version: RUN_STATE_VERSION,
    run_id: runId,
    state: "CREATED",
    workflow: "default",
    execution_mode: "delegated",
    current_unit: null,
    pending_review_findings: null,
    plan_commit: null,
    head_commit: null,
    implementer_commit: null,
    branch: null,
    impact: null,
    change_class: null,
    verification_policy: { exempt: false, reason: null },
    compatibility_mode: null,
    require_post_impact: true,
    blocked_from: null,
    resume_state: null,
    block_reason: null,
    block_code: null,
    agent_calls_used: 0,
    agent_call_budget: null,
    escalation_reasons: [],
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
  assertValidRunId(state.run_id);
  const v = validateRunState(state);
  if (!v.ok) {
    const err = new Error(
      `cannot write invalid run state: ${v.errors.map((e) => e.message).join("; ")}`,
    );
    err.validation = v;
    throw err;
  }
  const dir = path.dirname(runStatePath(worktree, state.run_id));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "state.json");

  return withFileLock(target, () => {
    // Optimistic concurrency control: a caller that read revision N must write
    // N (which we bump to N+1). If the on-disk revision advanced meanwhile,
    // another agent wrote first and this write is rejected so its changes are
    // not silently destroyed. Callers without a base revision (fresh init) skip
    // the check.
    const expectedRevision = Number.isInteger(state._revision)
      ? state._revision
      : null;
    if (expectedRevision !== null && fs.existsSync(target)) {
      let current = null;
      try {
        current = JSON.parse(fs.readFileSync(target, "utf8"));
      } catch {
        current = null;
      }
      const currentRevision = Number.isInteger(current?._revision)
        ? current._revision
        : 0;
      if (currentRevision !== expectedRevision) {
        const err = new Error(
          `run state revision conflict for ${state.run_id}: expected ${expectedRevision}, found ${currentRevision} (concurrent write)`,
        );
        err.code = "REVISION_CONFLICT";
        err.expected = expectedRevision;
        err.actual = currentRevision;
        throw err;
      }
    }

    const nextRevision =
      (Number.isInteger(state._revision) ? state._revision : 0) + 1;
    const { _revision: _drop, ...rest } = state;
    const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const next = { ...rest, _revision: nextRevision, updated_at: nowIso() };
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, target);
    return next;
  });
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
  let runId = fields.run_id || `inferred-${Date.now()}`;
  try {
    assertValidRunId(runId);
  } catch {
    runId = `inferred-${Date.now()}`;
  }
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
  let ambiguousImplementer = false;
  let ambiguousReview = false;
  if (fs.existsSync(handoffsDir)) {
    const runId = fields.run_id || null;
    const currentUnit = fields.current_unit || null;

    const candidates = [];
    for (const f of fs.readdirSync(handoffsDir)) {
      if (!f.endsWith(".json")) continue;
      const full = path.join(handoffsDir, f);
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        continue; // ignore corrupt
      }
      // Filter to this run and execution unit when the CONTEXT provides them.
      // A handoff that declares a different run_id/unit must never be selected.
      const handoffRun = raw.run_id ?? null;
      const handoffUnit = raw.unit_or_task ?? raw.task_id ?? null;
      if (runId && handoffRun && handoffRun !== runId) continue;
      if (currentUnit && handoffUnit && handoffUnit !== currentUnit) continue;

      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      const kind = f.includes("implementer")
        ? "implementer"
        : f.includes("reviewer")
          ? "reviewer"
          : null;
      if (!kind) continue;
      candidates.push({
        file: f,
        raw,
        kind,
        created_at: typeof raw.created_at === "string" ? raw.created_at : null,
        mtimeMs,
      });
    }

    // Sort by created_at (ISO) when available, else mtime; newest last.
    const byRecency = (a, b) => {
      if (a.created_at && b.created_at && a.created_at !== b.created_at) {
        return a.created_at < b.created_at ? -1 : 1;
      }
      return a.mtimeMs - b.mtimeMs;
    };

    const pickLatest = (kind) => {
      const list = candidates.filter((c) => c.kind === kind).sort(byRecency);
      if (list.length === 0) return { value: null, ambiguous: false };
      const newest = list[list.length - 1];
      // Ambiguous when the two most recent are indistinguishable in ordering
      // evidence (same/absent created_at AND same mtime) — do not guess.
      let ambiguous = false;
      if (list.length >= 2) {
        const prev = list[list.length - 2];
        const sameCreated =
          (newest.created_at || null) === (prev.created_at || null);
        if (sameCreated && newest.mtimeMs === prev.mtimeMs) ambiguous = true;
      }
      return { value: newest.raw, ambiguous };
    };

    const impl = pickLatest("implementer");
    const rev = pickLatest("reviewer");
    latestImplementer = impl.value;
    ambiguousImplementer = impl.ambiguous;
    latestReview = rev.value;
    ambiguousReview = rev.ambiguous;
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

  // Ambiguous latest handoff must block rather than silently guess.
  if (ambiguousImplementer || ambiguousReview) {
    state = "BLOCKED";
  }

  return createEmptyRunState(runId, {
    state,
    profile,
    plan_commit: fields.plan_commit || null,
    branch: fields.feature_branch || fields.branch || null,
    current_unit: fields.current_unit || null,
    block_reason:
      state === "BLOCKED"
        ? "ambiguous latest handoff: multiple candidates with indistinguishable recency"
        : null,
    block_code: state === "BLOCKED" ? "AMBIGUOUS_HANDOFF" : null,
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

export {
  RUN_STATE_VERSION,
  HANDOFF_VERSION,
  LEGACY_HANDOFF,
  LEGACY_HANDOFF_VERSIONS,
  isLegacyHandoffVersion,
};
