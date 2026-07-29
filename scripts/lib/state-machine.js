import fs from "fs";
import path from "path";
import { normalizeAndValidateHandoff } from "./migrate-artifacts.js";
import {
  validateClassification,
  validateBlastReport,
} from "./schema-validate.js";
import { isPlanCommitAcceptable } from "./drift.js";
import { createDefaultProviders } from "./providers.js";

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

/**
 * @param {object} state run state
 * @param {string} to
 * @param {object} ctx evidence + providers
 */
export function canTransition(state, to, ctx = {}) {
  const errors = [];
  const from = state?.state;
  if (!from) return { ok: false, errors: ["missing current state"] };
  if (!STATES.includes(to))
    return { ok: false, errors: [`unknown target state ${to}`] };

  if (to === "BLOCKED") {
    if (!ctx.block_reason && !ctx.reason)
      errors.push("BLOCKED requires reason");
    if (!ctx.block_code && !ctx.code)
      errors.push("BLOCKED requires classification code");
    return { ok: errors.length === 0, errors };
  }

  if (to === "FAILED") {
    if (!ctx.reason && !ctx.block_reason) errors.push("FAILED requires reason");
    return { ok: errors.length === 0, errors };
  }

  const allowed = new Set();
  const idx = LINEAR.indexOf(from);
  if (idx >= 0 && idx + 1 < LINEAR.length) allowed.add(LINEAR[idx + 1]);

  if (from === "CLASSIFIED" || from === "PLANNED")
    allowed.add("DIRECT_IMPLEMENTING");
  if (from === "DIRECT_IMPLEMENTING") {
    allowed.add("VERIFYING");
    allowed.add("BLOCKED");
  }
  if (
    from === "VERIFYING" &&
    (state.review_level === "none" || ctx.review_level === "none")
  ) {
    allowed.add("COMPLETED");
  }
  if (from === "BLOCKED" && ctx.resume_to && STATES.includes(ctx.resume_to)) {
    allowed.add(ctx.resume_to);
  }
  if (!["COMPLETED", "FAILED"].includes(from)) {
    allowed.add("BLOCKED");
    allowed.add("FAILED");
  }

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
    if (!g || g.ok === false)
      errors.push("GRAPH_READY requires graph provider OK");
    else if (g.confidence == null && !g.path && g.ok !== true) {
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
    if (!ctx.branch && !state.branch)
      errors.push("IMPLEMENTING requires assigned branch");
    const blast = ctx.blast?.report || ctx.blast || state.blast;
    const report = blast?.report || blast;
    if (!report || !(report.risk || report.level)) {
      errors.push("IMPLEMENTING requires valid blast report");
    }
    const criteria = ctx.acceptance_criteria || ctx.acceptanceCriteria;
    if (!criteria || (Array.isArray(criteria) && criteria.length === 0)) {
      errors.push("IMPLEMENTING requires acceptance criteria");
    }
    if (ctx.drift && !isPlanCommitAcceptable(ctx.drift)) {
      errors.push(`plan_commit not acceptable: drift ${ctx.drift.drift}`);
    }
  }

  if (to === "DIRECT_IMPLEMENTING") {
    const c = ctx.classification || state.classification || {};
    const eligible = c.direct_eligible === true || ctx.direct_eligible === true;
    const forbid =
      ctx.forbid_direct === true ||
      ctx.execution_mode === "delegated" ||
      (c.direct_eligible !== true && c.execution_mode === "delegated");

    if (!eligible) errors.push("DIRECT_IMPLEMENTING requires direct_eligible");
    if (forbid && !(ctx.dispatch_unavailable && eligible)) {
      errors.push("direct execution forbidden or not eligible");
    }
    if (c.confidence != null && c.confidence < 0.85) {
      errors.push("direct path requires confidence >= 0.85");
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
      }
    }
  }

  if (from === "VERIFYING" && to === "REVIEWING") {
    const skip = ctx.skip_review_prep === true;
    const gates =
      ctx.verification_gates || ctx.implementer_handoff?.verification_gates;
    const docsSkip =
      state.review_level === "none" || ctx.review_level === "none";
    if (!skip && !docsSkip && !Array.isArray(gates)) {
      errors.push(
        "REVIEWING requires verification_gates recorded (or skip policy)",
      );
    }
  }

  if (to === "COMPLETED") {
    const level = ctx.review_level || state.review_level || "unified";
    if (level === "none") {
      if (!["VERIFYING", "REVIEWING"].includes(from)) {
        errors.push(
          "COMPLETED with review_level none must come from VERIFYING or REVIEWING",
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
      }
      if (!code.ok || code.data.verdict !== "APPROVED") {
        errors.push("dual review requires code-reviewer APPROVED");
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

  const next = {
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
  if (to === "GRAPH_READY")
    next.graph = ctx.graph || evidence.graph || next.graph;
  if (to === "BLAST_READY") {
    const blast = ctx.blast?.report || ctx.blast || evidence.blast;
    next.blast = blast?.report || blast;
  }
  if (to === "IMPLEMENTING" || to === "DIRECT_IMPLEMENTING") {
    if (ctx.branch) next.branch = ctx.branch;
    if (ctx.current_unit) next.current_unit = ctx.current_unit;
  }
  if (to === "BLOCKED") {
    next.block_reason = ctx.block_reason || ctx.reason || null;
    next.block_code = ctx.block_code || ctx.code || null;
  }
  if (to === "DIRECT_IMPLEMENTING") next.execution_mode = "direct";

  prov.telemetry.emit({
    event: "transition",
    from: state.state,
    to,
    run_id: state.run_id,
    time: nowIso(),
  });

  return { ok: true, state: next, errors: [] };
}
