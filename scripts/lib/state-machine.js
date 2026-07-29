import fs from "fs";
import path from "path";
import { normalizeAndValidateHandoff } from "./migrate-artifacts.js";
import {
  validateClassification,
  validateBlastReport,
  validateDriftReport,
} from "./schema-validate.js";
import { isPlanCommitAcceptable } from "./drift.js";
import { createDefaultProviders } from "./providers.js";
import { effectivePolicy, applyBlastEscalation, maxReview } from "./policy.js";

export const STATES = [
  "CREATED",
  "CLASSIFIED",
  "PLANNED",
  "GRAPH_READY",
  "BLAST_READY",
  "IMPLEMENTING",
  "DIRECT_IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
];

export const LINEAR = [
  "CREATED",
  "CLASSIFIED",
  "PLANNED",
  "GRAPH_READY",
  "BLAST_READY",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "COMPLETED",
];

const TERMINAL = new Set(["COMPLETED", "FAILED"]);

function nowIso() {
  return new Date().toISOString();
}

function exists(p) {
  return !!p && fs.existsSync(p);
}

export function requiredEvidence(from, to) {
  const map = {
    "CREATED->CLASSIFIED": ["classification"],
    "CLASSIFIED->PLANNED": ["plan_path|plan_skip"],
    "PLANNED->GRAPH_READY": ["graph"],
    "GRAPH_READY->BLAST_READY": ["blast"],
    "BLAST_READY->IMPLEMENTING": [
      "branch",
      "blast",
      "acceptance_criteria",
      "drift",
    ],
    "CLASSIFIED->DIRECT_IMPLEMENTING": ["direct_eligible"],
    "PLANNED->DIRECT_IMPLEMENTING": ["direct_eligible"],
    "IMPLEMENTING->VERIFYING": ["implementer_handoff"],
    "DIRECT_IMPLEMENTING->VERIFYING": ["implementer_handoff"],
    "VERIFYING->REVIEWING": ["verification_gates|skip_review_prep"],
    "REVIEWING->COMPLETED": ["review_approval"],
    "VERIFYING->COMPLETED": ["review_level_none"],
  };
  return map[`${from}->${to}`] || [];
}

function bindHandoffErrors(data, state, role) {
  const errors = [];
  if (data.legacy_unverified === true) {
    errors.push(
      `${role} handoff is legacy_unverified and cannot satisfy gates`,
    );
  }
  if (state.run_id && data.run_id != null && data.run_id !== state.run_id) {
    errors.push(
      `${role} handoff run_id mismatch (got ${data.run_id}, want ${state.run_id})`,
    );
  }
  if (state.run_id && data.run_id == null) {
    errors.push(`${role} handoff missing run_id binding`);
  }
  const unit = state.current_unit;
  if (unit) {
    const handoffUnit = data.unit_or_task || data.task_id;
    if (!handoffUnit) {
      errors.push(`${role} handoff missing unit_or_task/task_id binding`);
    } else if (handoffUnit !== unit) {
      errors.push(
        `${role} handoff unit mismatch (got ${handoffUnit}, want ${unit})`,
      );
    }
  }
  const expectedCommit = state.implementer_commit || state.head_commit;
  if (expectedCommit) {
    const reviewed = data.reviewed_commit || data.commit;
    if (!reviewed) {
      errors.push(`${role} handoff missing reviewed_commit binding`);
    } else if (reviewed !== expectedCommit) {
      errors.push(
        `${role} handoff reviewed_commit mismatch (got ${reviewed}, want ${expectedCommit})`,
      );
    }
  }
  return errors;
}

function assertVerificationGates(data, state, errors) {
  if (data.legacy_unverified === true) {
    errors.push("implementer handoff is legacy_unverified");
    return;
  }
  const exempt =
    state.review_level === "none" ||
    data.verification_exempt === true ||
    (state.classification?.change_class === "documentation" &&
      state.execution_mode === "direct");

  const gates = data.verification_gates;
  if (!exempt) {
    if (!Array.isArray(gates) || gates.length === 0) {
      errors.push(
        "VERIFYING requires at least one verification gate (or explicit exemption)",
      );
    } else if (!gates.every((g) => g && g.pass === true)) {
      errors.push("all verification_gates must have pass === true");
    }
  }
  if (data.drift_check && data.drift_check.pass !== true && !exempt) {
    errors.push("drift_check.pass must be true");
  }
  const blastRequired =
    state.review_level !== "none" && state.execution_mode !== "direct";
  if (blastRequired) {
    if (!data.blast || data.blast.verified !== true) {
      errors.push(
        "blast.verified must be true when blast verification is required",
      );
    }
  }
}

/**
 * @param {object} state run state
 * @param {string} to
 * @param {object} ctx evidence (cannot weaken policy)
 */
export function canTransition(state, to, ctx = {}) {
  const errors = [];
  const from = state?.state;
  if (!from) return { ok: false, errors: ["missing current state"] };
  if (!STATES.includes(to)) {
    return { ok: false, errors: [`unknown target state ${to}`] };
  }

  // Terminal states are immutable
  if (TERMINAL.has(from)) {
    return { ok: false, errors: [`${from} is terminal`] };
  }

  const policy = effectivePolicy(state, ctx);

  if (to === "BLOCKED") {
    if (!ctx.block_reason && !ctx.reason)
      errors.push("BLOCKED requires reason");
    if (!ctx.block_code && !ctx.code) {
      errors.push("BLOCKED requires classification code");
    }
    return { ok: errors.length === 0, errors };
  }

  if (to === "FAILED") {
    if (!ctx.reason && !ctx.block_reason) errors.push("FAILED requires reason");
    return { ok: errors.length === 0, errors };
  }

  const allowed = new Set();
  const idx = LINEAR.indexOf(from);
  if (idx >= 0 && idx + 1 < LINEAR.length) allowed.add(LINEAR[idx + 1]);

  if (from === "CLASSIFIED" || from === "PLANNED") {
    allowed.add("DIRECT_IMPLEMENTING");
  }
  if (from === "DIRECT_IMPLEMENTING") {
    allowed.add("VERIFYING");
    allowed.add("BLOCKED");
  }
  // COMPLETED from VERIFYING only when stored review_level is none
  if (from === "VERIFYING" && policy.review_level === "none") {
    allowed.add("COMPLETED");
  }
  if (from === "BLOCKED" && ctx.resume_to && STATES.includes(ctx.resume_to)) {
    if (!TERMINAL.has(ctx.resume_to)) allowed.add(ctx.resume_to);
  }
  allowed.add("BLOCKED");
  allowed.add("FAILED");

  if (!allowed.has(to)) {
    errors.push(`illegal transition ${from} → ${to}`);
    return { ok: false, errors };
  }

  if (from === "CREATED" && to === "CLASSIFIED") {
    const c = ctx.classification || state.classification;
    const v = validateClassification(c || {});
    if (!v.ok) {
      errors.push(
        `classification invalid: ${v.errors.map((e) => e.message).join("; ")}`,
      );
    }
  }

  if (from === "CLASSIFIED" && to === "PLANNED") {
    const skip = ctx.plan_skip === true || ctx.planSkip === true;
    const planOk =
      skip ||
      ctx.plan_exists === true ||
      exists(ctx.plan_path) ||
      (ctx.worktree &&
        exists(path.join(ctx.worktree, ".opencode", "plans", "PLAN.md")));
    if (!planOk) errors.push("PLANNED requires PLAN.md or plan_skip");
  }

  if (to === "GRAPH_READY") {
    const g = ctx.graph || state.graph;
    if (!g || g.ok === false) {
      errors.push("GRAPH_READY requires graph provider OK");
    } else if (g.confidence == null && !g.path && g.ok !== true) {
      errors.push("graph confidence must be recorded");
    }
  }

  if (to === "BLAST_READY") {
    const blast = ctx.blast?.report || ctx.blast || state.blast;
    const report = blast?.report || blast;
    const normalized = {
      uncertainties: [],
      dimensions: {},
      ...(report || {}),
    };
    if (!normalized.risk && normalized.level)
      normalized.risk = normalized.level;
    const v = validateBlastReport(normalized);
    if (!v.ok) {
      errors.push(
        `blast report invalid: ${v.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!Array.isArray(normalized.uncertainties)) {
      errors.push("blast report must include uncertainties array");
    }
  }

  if (to === "IMPLEMENTING") {
    if (!ctx.branch && !state.branch) {
      errors.push("IMPLEMENTING requires assigned branch");
    }
    const blast = ctx.blast?.report || ctx.blast || state.blast;
    const report = blast?.report || blast;
    if (!report || !(report.risk || report.level)) {
      errors.push("IMPLEMENTING requires valid blast report");
    }
    const criteria = ctx.acceptance_criteria || ctx.acceptanceCriteria;
    if (!criteria || (Array.isArray(criteria) && criteria.length === 0)) {
      errors.push("IMPLEMENTING requires acceptance criteria");
    }
    // Drift is mandatory for engine-managed implementing
    const drift = ctx.drift;
    if (!drift) {
      errors.push("IMPLEMENTING requires valid DriftReport evidence");
    } else {
      const dv = validateDriftReport(drift);
      if (!dv.ok) {
        errors.push(
          `drift report invalid: ${dv.errors.map((e) => e.message).join("; ")}`,
        );
      } else if (!isPlanCommitAcceptable(drift)) {
        errors.push(`plan_commit not acceptable: drift ${drift.drift}`);
      }
      if (!drift.plan_commit && !state.plan_commit) {
        errors.push("drift/plan_commit must be recorded");
      }
      if (!drift.current_head && !ctx.current_head) {
        errors.push("drift current_head must be recorded");
      }
    }
  }

  if (to === "DIRECT_IMPLEMENTING") {
    // Only persisted classification may authorize direct — never ctx.direct_eligible
    if (!policy.direct_eligible) {
      errors.push(
        "DIRECT_IMPLEMENTING requires stored classification.direct_eligible (ctx cannot grant)",
      );
    }
    if (policy.execution_mode === "delegated" && !policy.direct_eligible) {
      errors.push("direct execution forbidden: execution_mode is delegated");
    }
    if (policy.confidence != null && policy.confidence < 0.85) {
      errors.push("direct path requires confidence >= 0.85");
    }
    // Dispatch-unavailable fallback still needs stored eligibility
    if (ctx.forbid_direct === true) {
      errors.push("direct execution explicitly forbidden");
    }
  }

  if (to === "VERIFYING") {
    const raw = ctx.implementer_handoff || ctx.handoff;
    if (!raw) errors.push("VERIFYING requires implementer handoff");
    else {
      const {
        ok,
        errors: he,
        data,
      } = normalizeAndValidateHandoff("implementer", raw);
      if (!ok) {
        errors.push(
          `implementer handoff invalid: ${he.map((e) => e.message).join("; ")}`,
        );
      } else if (!["DONE", "DONE_WITH_CONCERNS"].includes(data.status)) {
        errors.push(`implementer status must be DONE*, got ${data.status}`);
      } else {
        errors.push(...bindHandoffErrors(data, state, "implementer"));
        assertVerificationGates(data, { ...state, ...policy }, errors);
      }
    }
  }

  if (from === "VERIFYING" && to === "REVIEWING") {
    const skip = ctx.skip_review_prep === true;
    const docsSkip = policy.review_level === "none";
    const raw =
      ctx.implementer_handoff || ctx.handoff || state.last_implementer_handoff;
    const gates =
      ctx.verification_gates ||
      raw?.verification_gates ||
      state.last_implementer_handoff?.verification_gates;
    if (!skip && !docsSkip) {
      if (!Array.isArray(gates) || gates.length === 0) {
        errors.push(
          "REVIEWING requires non-empty verification_gates (or skip_review_prep)",
        );
      } else if (!gates.every((g) => g && g.pass === true)) {
        errors.push("verification_gates must all pass before REVIEWING");
      }
    }
  }

  if (to === "COMPLETED") {
    const level = policy.review_level;
    if (level === "none") {
      if (!["VERIFYING", "REVIEWING"].includes(from)) {
        errors.push(
          "COMPLETED with review_level none must come from VERIFYING or REVIEWING",
        );
      }
      const raw = ctx.implementer_handoff || state.last_implementer_handoff;
      if (raw?.legacy_unverified === true && !ctx.allow_legacy_complete) {
        errors.push(
          "legacy_unverified handoff cannot COMPLETE without allow_legacy_complete",
        );
      }
    } else if (level === "unified") {
      const h = ctx.unified_handoff || ctx.review_handoff;
      const {
        ok,
        data,
        errors: he,
      } = normalizeAndValidateHandoff("unified-reviewer", h || {});
      if (!ok) {
        errors.push(
          `unified review invalid: ${he.map((e) => e.message).join("; ")}`,
        );
      } else if (data.verdict !== "APPROVED") {
        errors.push(`unified review not APPROVED (${data.verdict})`);
      } else if (data.escalate_to_dual === true) {
        errors.push(
          "unified handoff escalate_to_dual=true — must run dual review, cannot COMPLETE",
        );
      } else {
        errors.push(...bindHandoffErrors(data, state, "unified-reviewer"));
      }
    } else if (level === "dual") {
      const spec = normalizeAndValidateHandoff(
        "spec-reviewer",
        ctx.spec_handoff || {},
      );
      const code = normalizeAndValidateHandoff(
        "code-reviewer",
        ctx.code_handoff || {},
      );
      if (!spec.ok || spec.data.verdict !== "APPROVED") {
        errors.push("dual review requires spec-reviewer APPROVED");
      } else {
        errors.push(...bindHandoffErrors(spec.data, state, "spec-reviewer"));
      }
      if (!code.ok || code.data.verdict !== "APPROVED") {
        errors.push("dual review requires code-reviewer APPROVED");
      } else {
        errors.push(...bindHandoffErrors(code.data, state, "code-reviewer"));
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Apply transition; returns { ok, state, errors }.
 */
export function transition(state, to, evidence = {}, providers = null) {
  const prov = providers || createDefaultProviders();
  const ctx = { ...evidence };
  const check = canTransition(state, to, ctx);
  if (!check.ok) return { ok: false, state, errors: check.errors };

  let next = {
    ...state,
    state: to,
    updated_at: nowIso(),
    transitions: [
      ...(state.transitions || []),
      {
        from: state.state,
        to,
        at: nowIso(),
        evidence: evidence.evidence_path || evidence.evidence || null,
      },
    ],
  };

  if (to === "CLASSIFIED" && (ctx.classification || evidence.classification)) {
    next.classification = ctx.classification || evidence.classification;
    next.profile = next.classification.profile || next.profile;
    next.review_level = next.classification.review_level || next.review_level;
    next.execution_mode =
      next.classification.execution_mode || next.execution_mode;
  }
  if (to === "GRAPH_READY") {
    next.graph = ctx.graph || evidence.graph || next.graph;
  }
  if (to === "BLAST_READY") {
    const blast = ctx.blast?.report || ctx.blast || evidence.blast;
    const report = blast?.report || blast;
    next = applyBlastEscalation(next, report);
  }
  if (to === "IMPLEMENTING" || to === "DIRECT_IMPLEMENTING") {
    if (ctx.branch) next.branch = ctx.branch;
    if (ctx.current_unit) next.current_unit = ctx.current_unit;
    if (ctx.drift?.plan_commit) next.plan_commit = ctx.drift.plan_commit;
    if (ctx.drift?.current_head) next.head_commit = ctx.drift.current_head;
    if (ctx.current_head) next.head_commit = ctx.current_head;
  }
  if (to === "VERIFYING") {
    const raw = ctx.implementer_handoff || ctx.handoff;
    if (raw) {
      const { data } = normalizeAndValidateHandoff("implementer", raw);
      next.last_implementer_handoff = data;
      if (data.commit) next.implementer_commit = data.commit;
    }
  }
  if (to === "BLOCKED") {
    next.block_reason = ctx.block_reason || ctx.reason || null;
    next.block_code = ctx.block_code || ctx.code || null;
  }
  if (to === "DIRECT_IMPLEMENTING") {
    // Keep stored direct mode; do not flip from delegated via this path unless already eligible
    next.execution_mode = "direct";
  }

  // Strip any ctx attempts to write weaker policy onto next
  // (BLAST_READY escalation already applied via applyBlastEscalation)

  prov.telemetry.emit({
    event: "transition",
    from: state.state,
    to,
    run_id: state.run_id,
    time: nowIso(),
  });

  return { ok: true, state: next, errors: [] };
}

export { effectivePolicy, maxReview };
