import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { normalizeAndValidateHandoff } from "./migrate-artifacts.js";
import {
  validateClassification,
  validateBlastReport,
  validateDriftReport,
} from "./schema-validate.js";
import { isPlanCommitAcceptable } from "./drift.js";
import { createDefaultProviders } from "./providers.js";
import {
  effectivePolicy,
  applyBlastEscalation,
  hasExplicitBlastVerification,
  isUnknownBlast,
  isUnknownGraph,
  isTrustedLowRiskBlast,
  maxReview,
} from "./policy.js";

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
export const CLASSIFY_APPLY_SOURCE = "classify-apply";

function nowIso() {
  return new Date().toISOString();
}

function exists(p) {
  return !!p && fs.existsSync(p);
}

function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function sealGraphArtifact(graph, worktreeHead = null) {
  if (!graph || typeof graph !== "object") return null;
  const sealed = {
    ...graph,
    worktree_head: worktreeHead || graph.worktree_head || null,
    provider_validated: true,
    validated_at: nowIso(),
  };
  delete sealed.artifact_digest;
  sealed.artifact_digest = sha256Digest(stableStringify(sealed));
  return sealed;
}

export function sealBlastArtifact(report, worktreeHead = null) {
  if (!report || typeof report !== "object") return null;
  const sealed = {
    ...report,
    worktree_head: worktreeHead || report.worktree_head || null,
    provider_validated: true,
    validated_at: nowIso(),
  };
  delete sealed.artifact_digest;
  sealed.artifact_digest = sha256Digest(stableStringify(sealed));
  return sealed;
}

export function verifySealedArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") return false;
  if (artifact.provider_validated !== true) return false;
  if (typeof artifact.artifact_digest !== "string") return false;
  const { artifact_digest, ...canonical } = artifact;
  return artifact_digest === sha256Digest(stableStringify(canonical));
}

function gitRevParse(worktree, rev = "HEAD") {
  if (!worktree) return null;
  const r = spawnSync("git", ["rev-parse", rev], {
    cwd: worktree,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return String(r.stdout || "").trim() || null;
}

function gitIsAncestor(worktree, ancestor, descendant) {
  if (!worktree || !ancestor || !descendant) return null;
  if (ancestor === descendant) return true;
  const r = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: worktree, encoding: "utf8" },
  );
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
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

function sharedHandoffBindingErrors(data, state, role) {
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
  if (state.run_id && (data.run_id == null || data.run_id === "")) {
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
  return errors;
}

/**
 * Implementer binding: base_commit must match pre-implementation head_commit;
 * commit is the new implementation commit (not the pre-impl HEAD).
 */
export function bindImplementerHandoffErrors(data, state, ctx = {}) {
  const errors = sharedHandoffBindingErrors(data, state, "implementer");
  const base = state.head_commit;
  if (base) {
    if (!data.base_commit) {
      errors.push("implementer handoff missing base_commit binding");
    } else if (data.base_commit !== base) {
      errors.push(
        `implementer handoff base_commit mismatch (got ${data.base_commit}, want ${base})`,
      );
    }
  }
  if (!data.commit) {
    errors.push("implementer handoff missing commit binding");
  } else if (base && data.commit === base && ctx.require_new_commit === true) {
    errors.push(
      "implementer handoff commit must be a new implementation commit, not base_commit",
    );
  }

  const worktree = ctx.worktree || state.worktree;
  if (worktree && data.commit) {
    const head = gitRevParse(worktree, "HEAD");
    if (head && data.commit !== head) {
      errors.push(
        `implementer handoff commit mismatch vs feature-branch HEAD (got ${data.commit}, want ${head})`,
      );
    }
    if (data.base_commit && data.commit) {
      const ancestor = gitIsAncestor(worktree, data.base_commit, data.commit);
      if (ancestor === false) {
        errors.push(
          "implementer handoff commit is not a descendant of base_commit",
        );
      }
    }
  }
  return errors;
}

/**
 * Reviewer binding: reviewed_commit must equal implementer_commit (post-impl).
 */
export function bindReviewerHandoffErrors(data, state, role) {
  const errors = sharedHandoffBindingErrors(data, state, role);
  const expected = state.implementer_commit;
  if (expected) {
    if (!data.reviewed_commit) {
      errors.push(`${role} handoff missing reviewed_commit binding`);
    } else if (data.reviewed_commit !== expected) {
      errors.push(
        `${role} handoff reviewed_commit mismatch (got ${data.reviewed_commit}, want ${expected})`,
      );
    }
  } else if (state.head_commit && data.reviewed_commit) {
    // No implementer_commit yet — reject using pre-impl head as a stand-in
    if (
      data.reviewed_commit === state.head_commit &&
      !state.implementer_commit
    ) {
      errors.push(
        `${role} handoff reviewed_commit cannot bind to pre-implementation head_commit`,
      );
    }
  }
  return errors;
}

function verificationPolicyExempt(state) {
  const policy = state?.verification_policy;
  return policy && policy.exempt === true;
}

function assertVerificationGates(data, state, errors) {
  if (data.legacy_unverified === true) {
    errors.push("implementer handoff is legacy_unverified");
    return;
  }
  // Implementer-controlled verification_exempt is never honored.
  const exempt = verificationPolicyExempt(state);

  const gates = data.verification_gates;
  if (!exempt) {
    if (!Array.isArray(gates) || gates.length === 0) {
      errors.push(
        "VERIFYING requires at least one verification gate (or run verification_policy.exempt)",
      );
    } else if (!gates.every((g) => g && g.pass === true)) {
      errors.push("all verification_gates must have pass === true");
    }
    if (!data.drift_check || typeof data.drift_check !== "object") {
      errors.push("VERIFYING requires drift_check");
    } else if (data.drift_check.pass !== true) {
      errors.push("drift_check.pass must be true");
    }
  }
  const blastRequired =
    !exempt &&
    state.review_level !== "none" &&
    state.execution_mode !== "direct";
  if (blastRequired) {
    if (!data.blast || data.blast.verified !== true) {
      errors.push(
        "blast.verified must be true when blast verification is required",
      );
    }
  }
}

function isProviderTrustedGraph(graph) {
  return (
    verifySealedArtifact(graph) &&
    !isUnknownGraph(graph) &&
    graph.trusted === true
  );
}

function isProviderTrustedLowBlast(blast) {
  return verifySealedArtifact(blast) && isTrustedLowRiskBlast(blast);
}

/**
 * Revalidate graph/blast via providers. Caller-supplied trusted labels are ignored.
 */
export function revalidateTransitionEvidence(to, ctx, providers) {
  const worktree = ctx.worktree || process.cwd();
  const head = gitRevParse(worktree, "HEAD");
  const next = { ...ctx };
  const errors = [];

  if (to === "GRAPH_READY" || to === "DIRECT_IMPLEMENTING") {
    if (providers?.graphProvider?.build) {
      const built = providers.graphProvider.build({
        worktree,
        force: !!ctx.force,
        path: ctx.graph_path || ctx.graph?.path,
      });
      if (!built) {
        next.graph = { ok: false, error: "graph provider returned empty" };
      } else if (built.ok === false) {
        // Persist provider outcome (possibly untrusted). Direct path will reject later.
        next.graph = sealGraphArtifact(
          { ...built, trusted: false, quality: built.quality || "UNKNOWN" },
          head,
        );
      } else {
        next.graph = sealGraphArtifact(built, head);
      }
    } else if (ctx.graph) {
      // No provider — never accept caller trust labels
      if (ctx.graph.trusted === true && !verifySealedArtifact(ctx.graph)) {
        errors.push(
          "graph trusted label rejected: provider revalidation required",
        );
        next.graph = { ok: false, trusted: false, fabricated: true };
      }
    }
  }

  if (to === "BLAST_READY" || to === "DIRECT_IMPLEMENTING") {
    if (providers?.blastProvider?.analyze) {
      const analyzed = providers.blastProvider.analyze({
        worktree,
        reportPath: ctx.blast_path || ctx["blast-path"],
        mermaid: !!ctx.mermaid,
        files: ctx.files || ctx.changed_files,
        report: verifySealedArtifact(ctx.blast?.report || ctx.blast)
          ? ctx.blast?.report || ctx.blast
          : undefined,
      });
      const report = analyzed?.report || analyzed;
      if (report && typeof report === "object") {
        const nextReport = { ...report };
        if (report.trusted === true && analyzed?.ok !== false) {
          nextReport.trusted = true;
        } else if (report.trusted !== true) {
          // Do not force trusted:false — that marks analysis UNKNOWN in policy helpers
          delete nextReport.trusted;
        }
        next.blast = sealBlastArtifact(nextReport, head);
      } else if (to === "BLAST_READY") {
        errors.push(
          `blast provider rejected artifact: ${analyzed?.error || "not ok"}`,
        );
      }
    } else if (ctx.blast) {
      const blast = ctx.blast?.report || ctx.blast;
      if (blast?.trusted === true && !verifySealedArtifact(blast)) {
        errors.push(
          "blast trusted label rejected: provider revalidation required",
        );
        next.blast = { risk: "UNKNOWN", trusted: false, fabricated: true };
      }
    }
  }

  return { ctx: next, errors };
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
    if (g?.fabricated === true) {
      errors.push("GRAPH_READY rejects fabricated graph trust labels");
    } else if (g?.trusted === true && !verifySealedArtifact(g)) {
      errors.push(
        "GRAPH_READY rejects unsealed trusted graph; provider revalidation required",
      );
    } else if (!g) {
      errors.push("GRAPH_READY requires graph provider result");
    } else if (g.ok === false && !g.path && !g.snapshot && !g.artifact_digest) {
      errors.push("GRAPH_READY requires graph provider OK");
    } else if (
      g.confidence == null &&
      !g.path &&
      g.ok !== true &&
      !g.artifact_digest
    ) {
      errors.push("graph confidence must be recorded");
    }
  }

  if (to === "BLAST_READY") {
    const blast = ctx.blast?.report || ctx.blast || state.blast;
    const report = blast?.report || blast;
    if (report?.fabricated === true) {
      errors.push("BLAST_READY rejects fabricated blast trust labels");
    }
    if (report?.trusted === true && !verifySealedArtifact(report)) {
      errors.push(
        "BLAST_READY rejects unsealed trusted blast; provider revalidation required",
      );
    }
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
    if (
      isUnknownBlast(normalized) &&
      !hasExplicitBlastVerification(
        ctx.blast_verification || ctx.verification_evidence || state.blast_verification,
      )
    ) {
      errors.push(
        "UNKNOWN blast analysis requires explicit blast_verification evidence before BLAST_READY",
      );
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
    if (
      isUnknownBlast(report) &&
      !hasExplicitBlastVerification(state.blast_verification)
    ) {
      errors.push(
        "IMPLEMENTING cannot proceed with UNKNOWN blast analysis without persisted blast_verification",
      );
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
    // Only classify --apply may authorize direct — never transition --json classification
    const source =
      state.classification_source ||
      state.classification?.classification_source ||
      ctx.classification_source;
    if (source !== CLASSIFY_APPLY_SOURCE) {
      errors.push(
        "DIRECT_IMPLEMENTING requires classification persisted by classify --apply",
      );
    }
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
    // PR A: existing-diff-only (two-stage direct is PR B)
    if (state.classification?.diff_clean === true) {
      errors.push(
        "direct execution requires existing non-clean diff (existing-diff-only in PR A)",
      );
    }
    if (ctx.forbid_direct === true) {
      errors.push("direct execution explicitly forbidden");
    }
    const blast = ctx.blast?.report || ctx.blast || state.blast;
    const graph = ctx.graph || state.graph;
    if (!isProviderTrustedLowBlast(blast)) {
      errors.push(
        "direct execution requires a provider-revalidated sealed LOW blast analysis",
      );
    }
    if (!isProviderTrustedGraph(graph)) {
      errors.push(
        "direct execution requires a provider-revalidated sealed PRECISE graph analysis",
      );
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
        errors.push(
          ...bindImplementerHandoffErrors(data, state, {
            worktree: ctx.worktree,
            require_new_commit: ctx.require_new_commit === true,
          }),
        );
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
        errors.push(
          ...bindReviewerHandoffErrors(data, state, "unified-reviewer"),
        );
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
        errors.push(
          ...bindReviewerHandoffErrors(spec.data, state, "spec-reviewer"),
        );
      }
      if (!code.ok || code.data.verdict !== "APPROVED") {
        errors.push("dual review requires code-reviewer APPROVED");
      } else {
        errors.push(
          ...bindReviewerHandoffErrors(code.data, state, "code-reviewer"),
        );
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
  let ctx = { ...evidence };

  if (
    to === "GRAPH_READY" ||
    to === "BLAST_READY" ||
    to === "DIRECT_IMPLEMENTING"
  ) {
    const revalidated = revalidateTransitionEvidence(to, ctx, prov);
    ctx = revalidated.ctx;
    if (revalidated.errors.length) {
      return { ok: false, state, errors: revalidated.errors };
    }
  }

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
    let classification = {
      ...(ctx.classification || evidence.classification),
    };
    const fromClassifyApply =
      ctx.classification_source === CLASSIFY_APPLY_SOURCE ||
      evidence.classification_source === CLASSIFY_APPLY_SOURCE ||
      classification.classification_source === CLASSIFY_APPLY_SOURCE;

    if (!fromClassifyApply) {
      // transition --json/--classification cannot authorize direct
      classification = {
        ...classification,
        direct_eligible: false,
        execution_mode:
          classification.execution_mode === "direct"
            ? "delegated"
            : classification.execution_mode || "delegated",
        classification_source: "transition-untrusted",
      };
      next.classification_source = "transition-untrusted";
    } else {
      classification.classification_source = CLASSIFY_APPLY_SOURCE;
      next.classification_source = CLASSIFY_APPLY_SOURCE;
      if (
        classification.change_class === "documentation" &&
        classification.execution_mode === "direct" &&
        classification.direct_eligible === true
      ) {
        next.verification_policy = {
          exempt: true,
          reason: "documentation-only direct path",
        };
      } else if (classification.review_level === "none") {
        next.verification_policy = {
          exempt: true,
          reason: "review_level none — documentation/formatting path",
        };
      }
    }

    next.classification = classification;
    next.profile = classification.profile || next.profile;
    next.review_level = classification.review_level || next.review_level;
    next.execution_mode = classification.execution_mode || next.execution_mode;
  }
  if (to === "GRAPH_READY") {
    next.graph = ctx.graph || evidence.graph || next.graph;
  }
  if (to === "BLAST_READY") {
    const blast = ctx.blast?.report || ctx.blast || evidence.blast;
    const report = blast?.report || blast;
    next = applyBlastEscalation(next, report);
    const verification =
      ctx.blast_verification ||
      ctx.verification_evidence ||
      next.blast_verification;
    if (hasExplicitBlastVerification(verification)) {
      next.blast_verification = verification;
    }
  }
  if (to === "IMPLEMENTING" || to === "DIRECT_IMPLEMENTING") {
    if (ctx.branch) next.branch = ctx.branch;
    if (ctx.current_unit) next.current_unit = ctx.current_unit;
    if (ctx.drift?.plan_commit) next.plan_commit = ctx.drift.plan_commit;
    // head_commit is the pre-implementation base only
    if (ctx.drift?.current_head) next.head_commit = ctx.drift.current_head;
    if (ctx.current_head) next.head_commit = ctx.current_head;
    if (ctx.graph) next.graph = ctx.graph;
    if (ctx.blast) next.blast = ctx.blast?.report || ctx.blast;
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
    next.execution_mode = "direct";
  }

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
