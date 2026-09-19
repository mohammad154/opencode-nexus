/**
 * Trusted execution-policy snapshots.
 *
 * Scope policy is project configuration and therefore candidate-controlled
 * after an implementation starts. Controllers capture its normalized form
 * before IMPLEMENTING and pass that value explicitly to impact/verification.
 */
import { sha256Digest, stableStringify } from "./artifact-seal.js";
import {
  DEFAULT_SCOPE_ALLOWED_PATTERNS,
  DEFAULT_IGNORE_PATTERNS,
  loadScopePolicy,
} from "./path-filter.js";

const POLICY_SNAPSHOT_VERSION = "1.0";

function normalizedPatterns(value, fallback) {
  const values = Array.isArray(value) ? value : fallback;
  return [...new Set(
    values
      .map((pattern) => String(pattern || "").replace(/\\/g, "/").trim())
      .filter(Boolean),
  )];
}

/** Return only the path-policy fields consumed by trusted analysis. */
export function normalizeScopePolicy(policy = {}) {
  const ignored = normalizedPatterns(
    policy.ignored_patterns || policy.ignored || policy.ignore_patterns,
    DEFAULT_IGNORE_PATTERNS,
  );
  const allowed = normalizedPatterns(
    policy.allowed || policy.allowed_patterns,
    DEFAULT_SCOPE_ALLOWED_PATTERNS,
  );
  return {
    schema_version: String(policy.schema_version || "1.0"),
    allowed,
    ignored,
    ignored_patterns: [...ignored],
  };
}

export function policyDigest(policy) {
  return sha256Digest(stableStringify(normalizeScopePolicy(policy)));
}

function bindingValue(value) {
  return value == null ? null : String(value);
}

/** Capture the policy and the immutable identity it is authorized for. */
export function createPolicySnapshot(worktree, {
  runId = null,
  unitOrTask = null,
  baseCommit = null,
  planCommit = null,
  sourceCommit = null,
  capturedAt = new Date().toISOString(),
} = {}) {
  const policy = normalizeScopePolicy(loadScopePolicy(worktree));
  const snapshot = {
    schema_version: POLICY_SNAPSHOT_VERSION,
    run_id: bindingValue(runId),
    unit_or_task: bindingValue(unitOrTask),
    base_commit: bindingValue(baseCommit),
    plan_commit: bindingValue(planCommit),
    source_commit: bindingValue(sourceCommit),
    captured_at: capturedAt,
    policy,
  };
  return {
    ...snapshot,
    policy_digest: policyDigest(policy),
  };
}

export function validatePolicySnapshot(snapshot, {
  runId = null,
  unitOrTask = null,
  baseCommit = null,
  planCommit = null,
  sourceCommit = null,
} = {}) {
  const errors = [];
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, errors: ["policy snapshot is missing"] };
  }
  if (String(snapshot.schema_version || "") !== POLICY_SNAPSHOT_VERSION) {
    errors.push(`unsupported policy snapshot schema: ${snapshot.schema_version || "missing"}`);
  }
  if (!snapshot.policy || typeof snapshot.policy !== "object") {
    errors.push("policy snapshot policy is missing");
  } else if (snapshot.policy_digest !== policyDigest(snapshot.policy)) {
    errors.push("policy snapshot digest mismatch");
  }
  if (typeof snapshot.captured_at !== "string" || !snapshot.captured_at) {
    errors.push("policy snapshot captured_at is missing");
  }
  const bindings = [
    ["run_id", runId],
    ["unit_or_task", unitOrTask],
    ["base_commit", baseCommit],
    ["plan_commit", planCommit],
    ["source_commit", sourceCommit],
  ];
  for (const [field, expected] of bindings) {
    if (expected != null && String(snapshot[field] || "") !== String(expected)) {
      errors.push(`policy snapshot ${field} mismatch`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    policy: errors.length === 0 ? normalizeScopePolicy(snapshot.policy) : null,
  };
}

/**
 * Resolve the policy authorized for a run. Legacy callers may use the current
 * policy only when `required` is false; VERIFYING callers must require a
 * valid pre-implementation snapshot.
 */
export function trustedPolicyForState(state, worktree, { required = false } = {}) {
  const snapshot = state?.policy_snapshot;
  if (!snapshot) return required ? null : normalizeScopePolicy(loadScopePolicy(worktree));
  const checked = validatePolicySnapshot(snapshot, {
    runId: state?.run_id,
    unitOrTask: state?.current_unit,
    baseCommit: state?.run_base_commit || state?.base_commit || state?.head_commit,
    planCommit: state?.plan_commit,
    sourceCommit: state?.source_commit || state?.head_commit,
  });
  if (!checked.ok) return null;
  return {
    ...checked.policy,
    policy_digest: snapshot.policy_digest,
  };
}

export { POLICY_SNAPSHOT_VERSION };
