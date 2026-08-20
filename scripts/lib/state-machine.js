import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { normalizeAndValidateHandoff } from "./migrate-artifacts.js";
import {
  validateClassification,
  validateBlastReport,
  validateDriftReport,
  validateImpactReport,
} from "./schema-validate.js";
import { isPlanCommitAcceptable } from "./drift.js";
import { createDefaultProviders } from "./providers.js";
import {
  sealProviderArtifact,
  verifySealedArtifact,
} from "./artifact-seal.js";
import {
  effectivePolicy,
  applyBlastEscalation,
  applyImpactEscalation,
  hasExplicitBlastVerification,
  hasExplicitImpactVerification,
  isUnknownBlast,
  isUnknownGraph,
  isUnknownImpact,
  isTrustedLowRiskBlast,
  isTrustedLowRiskImpact,
  maxReview,
  requiresTdd,
  isMultiTaskRun,
  isAcceptablePreImpact,
} from "./policy.js";

export const STATES = [
  "CREATED",
  "CLASSIFIED",
  "PLANNED",
  "IMPACT_READY",
  "IMPLEMENTING",
  "DIRECT_IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "FINAL_VERIFYING",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
];

export const LINEAR = [
  "CREATED",
  "CLASSIFIED",
  "PLANNED",
  "IMPACT_READY",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "FINAL_VERIFYING",
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

export function sealImpactArtifact(report, worktreeHead = null) {
  return sealProviderArtifact(report, worktreeHead);
}

/** Seal provider-run verification evidence bound to worktree HEAD. */
export function sealVerificationReport(report, worktreeHead = null) {
  return sealProviderArtifact(report, worktreeHead);
}

export { verifySealedArtifact };

/** @deprecated Use sealImpactArtifact */
export function sealGraphArtifact(graph, worktreeHead = null) {
  return sealImpactArtifact(graph, worktreeHead);
}

/** @deprecated Use sealImpactArtifact */
export function sealBlastArtifact(report, worktreeHead = null) {
  return sealImpactArtifact(report, worktreeHead);
}

function assertProviderVerification(ctx, state, errors, { phase = "implementer" } = {}) {
  const field = phase === "final" ? "final_verification" : "provider_verification";
  const candidate = ctx[field] || (phase === "final" ? state.final_verification : state.provider_verification);
  if (ctx[field] && !verifySealedArtifact(ctx[field])) {
    errors.push(`caller-supplied ${field} rejected — must be provider-sealed`);
    return;
  }
  if (!verifySealedArtifact(candidate)) {
    errors.push(`${phase === "final" ? "FINAL_VERIFYING" : "VERIFYING"} requires provider-run sealed verification`);
    return;
  }
  if (candidate.ok !== true) {
    errors.push("provider verification failed");
  }
  const worktree = ctx.worktree;
  if (worktree && candidate.worktree_head) {
    const head = gitRevParse(worktree, "HEAD");
    if (head && candidate.worktree_head !== head) {
      errors.push(`${field} worktree_head mismatch with current HEAD`);
    }
  }
}

function assertPostImpactEvidence(ctx, state, errors) {
  const post = ctx.post_impact || state.post_impact;
  if (!verifySealedArtifact(post)) {
    errors.push("VERIFYING requires sealed post-impact analysis");
    return;
  }
  const worktree = ctx.worktree;
  if (worktree && post.worktree_head) {
    const head = gitRevParse(worktree, "HEAD");
    if (head && post.worktree_head !== head) {
      errors.push("post-impact worktree_head mismatch with current HEAD");
    }
  }
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
    "PLANNED->IMPACT_READY": ["impact"],
    "IMPACT_READY->IMPLEMENTING": [
      "branch",
      "impact",
      "acceptance_criteria",
      "drift",
    ],
    "CLASSIFIED->DIRECT_IMPLEMENTING": ["direct_eligible"],
    "PLANNED->DIRECT_IMPLEMENTING": ["direct_eligible"],
    "IMPLEMENTING->VERIFYING": ["implementer_handoff"],
    "DIRECT_IMPLEMENTING->VERIFYING": ["implementer_handoff"],
    "VERIFYING->REVIEWING": ["provider_verification"],
    "REVIEWING->FINAL_VERIFYING": ["review_approval"],
    "FINAL_VERIFYING->COMPLETED": ["final_verification"],
    "REVIEWING->COMPLETED": ["review_approval|legacy_skip_final+compatibility_mode_v3"],
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

function assertVerificationGates(data, state, errors, ctx = {}) {
  if (data.legacy_unverified === true) {
    errors.push("implementer handoff is legacy_unverified");
    return;
  }
  const exempt = verificationPolicyExempt(state);

  if (!exempt) {
    assertProviderVerification(ctx, state, errors, { phase: "implementer" });
    const impactRequired =
      state.review_level !== "none" && state.execution_mode !== "direct";
    if (impactRequired) {
      assertPostImpactEvidence(ctx, state, errors);
      const impactOk =
        (data.impact && data.impact.verified === true) ||
        (data.blast && data.blast.verified === true);
      if (!impactOk) {
        errors.push(
          "impact.verified (or legacy blast.verified) must be true when impact verification is required",
        );
      }
    }
    if (!data.drift_check || typeof data.drift_check !== "object") {
      errors.push("VERIFYING requires drift_check");
    } else if (data.drift_check.pass !== true) {
      errors.push("drift_check.pass must be true");
    }
  }

  const tddRequired = requiresTdd(state) && !exempt;
  if (tddRequired) {
    if (!data.tdd?.red || data.tdd.red.exit_code === 0) {
      errors.push("TDD requires red evidence with non-zero exit_code before fix");
    }
    if (!data.tdd?.green || data.tdd.green.exit_code !== 0) {
      errors.push("TDD requires green evidence with exit_code 0 after fix");
    }
  }
}

function isProviderTrustedImpact(impact) {
  return verifySealedArtifact(impact) && isTrustedLowRiskImpact(impact);
}

function allowsLegacySkipFinal(state, ctx) {
  if (ctx.legacy_skip_final !== true) return false;
  return (
    state.compatibility_mode === "v3" ||
    state.classification?.compatibility_mode === "v3"
  );
}

function loadRunBaseline(state, ctx, worktree) {
  if (ctx.baseline && typeof ctx.baseline === "object") return ctx.baseline;
  if (state.baseline && typeof state.baseline === "object") return state.baseline;
  if (!worktree || !state.run_id) return null;
  const p = path.join(
    worktree,
    ".opencode",
    "runs",
    state.run_id,
    "baseline.json",
  );
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Revalidate impact via providers. Caller-supplied trusted labels are ignored.
 * Digests never establish authenticity — always recompute at safety gates.
 */
export function revalidateTransitionEvidence(to, ctx, providers, state = {}) {
  const worktree = ctx.worktree || process.cwd();
  const head = gitRevParse(worktree, "HEAD");
  const next = { ...ctx };
  const errors = [];

  if (to === "IMPACT_READY" || to === "DIRECT_IMPLEMENTING") {
    if (providers?.impactProvider?.analyze) {
      const analyzed = providers.impactProvider.analyze({
        worktree,
        reportPath: ctx.impact_path || ctx["impact-path"] || ctx.blast_path,
        base: ctx.base,
        change_class:
          ctx.change_class ||
          ctx.classification?.change_class ||
          state.classification?.change_class,
        planned_targets:
          ctx.planned_targets || ctx.targets || ctx.allowed_files || ctx.files,
        // Never pass sealed inline report — digests are not provenance.
        files: ctx.files || ctx.changed_files,
        force_recompute: true,
      });
      const report = analyzed?.report || analyzed;
      if (report && typeof report === "object") {
        const nextReport = { ...report };
        if (nextReport.confidence == null) nextReport.confidence = 0.85;
        if (!nextReport.schema_version) nextReport.schema_version = "1.0";
        next.impact = sealImpactArtifact(nextReport, head);
        next.blast = next.impact;
        next.graph = sealImpactArtifact(
          {
            ok: nextReport.ok !== false,
            trusted: nextReport.trusted === true,
            quality: nextReport.analysis_quality || "PRECISE",
            stale: false,
            fresh: true,
            freshness: nextReport.graph_freshness || { valid: true },
            confidence: nextReport.confidence ?? 0,
            graph_provider: nextReport.provider || "nexus-impact",
          },
          head,
        );
        if (isAcceptablePreImpact(nextReport)) {
          next.require_post_impact = true;
        }
      } else if (to === "IMPACT_READY") {
        errors.push(
          `impact provider rejected artifact: ${analyzed?.error || "not ok"}`,
        );
      }
    } else if (providers?.blastProvider?.analyze) {
      const analyzed = providers.blastProvider.analyze({
        worktree,
        reportPath: ctx.blast_path || ctx.impact_path,
        files: ctx.files || ctx.changed_files,
        // Do not accept sealed inline blast as provenance.
      });
      const report = analyzed?.report || analyzed;
      if (report && typeof report === "object") {
        next.impact = sealImpactArtifact(
          {
            schema_version: "1.0",
            confidence: report.confidence ?? 0.85,
            ...report,
          },
          head,
        );
        next.blast = next.impact;
      } else if (to === "IMPACT_READY") {
        errors.push(
          `impact provider rejected artifact: ${analyzed?.error || "not ok"}`,
        );
      }
    } else if (ctx.impact || ctx.blast) {
      const report = ctx.impact?.report || ctx.impact || ctx.blast?.report || ctx.blast;
      if (report?.trusted === true) {
        errors.push(
          "impact trusted label rejected: provider revalidation required",
        );
        next.impact = {
          risk: "UNKNOWN",
          confidence: 0,
          trusted: false,
          fabricated: true,
        };
      }
    }
  }

  if (to === "VERIFYING" || (to === "COMPLETED" && state.state === "FINAL_VERIFYING")) {
    const exempt = verificationPolicyExempt(state);
    if (!exempt && providers?.impactProvider?.analyze && to === "VERIFYING") {
      const analyzed = providers.impactProvider.analyze({
        worktree,
        base: ctx.base || state.head_commit || state.plan_commit,
        change_class: state.classification?.change_class,
        phase: "post",
        post_impact: true,
        force_recompute: true,
      });
      const report = analyzed?.report || analyzed;
      if (report && typeof report === "object") {
        next.post_impact = sealImpactArtifact(report, head);
        next.require_post_impact = false;
      } else {
        errors.push(
          `post-impact provider rejected artifact: ${analyzed?.error || "not ok"}`,
        );
      }
    }
    if (!exempt && providers?.verificationProvider?.run) {
      const field =
        to === "COMPLETED" ? "final_verification" : "provider_verification";
      const related =
        next.post_impact?.related_tests ||
        state.post_impact?.related_tests ||
        state.impact?.related_tests ||
        [];
      const run = providers.verificationProvider.run({
        worktree,
        related_tests: related,
        plan: providers.verificationProvider.discover?.({
          worktree,
          related_tests: related,
        }),
      });
      const baseline = loadRunBaseline(state, ctx, worktree);
      let baseline_comparison = null;
      let ok = run?.ok === true;
      if (baseline && providers.verificationProvider.compare) {
        baseline_comparison = providers.verificationProvider.compare(
          baseline,
          run,
        );
        if (baseline_comparison.ok !== true) {
          ok = false;
          errors.push(
            `new verification regressions vs baseline: ${(
              baseline_comparison.new_regressions || []
            )
              .map((r) => r.id || r.command)
              .join(", ") || "unknown"}`,
          );
        }
      }
      const sealed = sealVerificationReport(
        {
          ok,
          results: run?.results || [],
          plan: run?.plan,
          source: "verification-provider",
          baseline_comparison,
        },
        head,
      );
      next[field] = sealed;
    } else if (!exempt && to === "COMPLETED") {
      if (ctx.skip_final_verification === true) {
        errors.push("skip_final_verification is not allowed");
      }
      if (
        ctx.final_verification &&
        !verifySealedArtifact(ctx.final_verification)
      ) {
        errors.push(
          "caller-supplied final_verification rejected — must be provider-sealed",
        );
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
  // Legacy: REVIEWING → COMPLETED still allowed when skip_final is set (PR11 tightens)
  if (from === "REVIEWING") {
    allowed.add("FINAL_VERIFYING");
    allowed.add("COMPLETED");
  }
  if (from === "FINAL_VERIFYING") {
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

  if (to === "IMPACT_READY") {
    const impact = ctx.impact?.report || ctx.impact || state.impact || ctx.blast || state.blast;
    const report = impact?.report || impact;
    if (report?.fabricated === true) {
      errors.push("IMPACT_READY rejects fabricated impact trust labels");
    }
    if (report?.trusted === true && !verifySealedArtifact(report)) {
      errors.push(
        "IMPACT_READY rejects unsealed trusted impact; provider revalidation required",
      );
    }
    if (!report) {
      errors.push("IMPACT_READY requires impact provider result");
    } else {
      const normalized = {
        uncertainties: [],
        dimensions: {},
        confidence: report.confidence ?? 0,
        ...report,
      };
      if (!normalized.risk && normalized.level) normalized.risk = normalized.level;
      const v = validateImpactReport(normalized);
      if (!v.ok) {
        // Fall back to blast schema for transitional reports
        const bv = validateBlastReport(normalized);
        if (!bv.ok) {
          errors.push(
            `impact report invalid: ${v.errors.map((e) => e.message).join("; ")}`,
          );
        }
      }
      if (
        isUnknownImpact(normalized) &&
        !isAcceptablePreImpact(normalized) &&
        !hasExplicitImpactVerification(
          ctx.impact_verification ||
            ctx.blast_verification ||
            ctx.verification_evidence ||
            state.impact_verification ||
            state.blast_verification,
        )
      ) {
        errors.push(
          "UNKNOWN impact analysis requires explicit impact_verification evidence before IMPACT_READY",
        );
      }
    }
  }

  if (to === "IMPLEMENTING") {
    if (!ctx.branch && !state.branch) {
      errors.push("IMPLEMENTING requires assigned branch");
    }
    const impact =
      ctx.impact?.report ||
      ctx.impact ||
      state.impact ||
      ctx.blast?.report ||
      ctx.blast ||
      state.blast;
    const report = impact?.report || impact;
    if (!report || !(report.risk || report.level)) {
      errors.push("IMPLEMENTING requires valid impact report");
    }
    if (
      isUnknownImpact(report) &&
      !isAcceptablePreImpact(report) &&
      !hasExplicitImpactVerification(
        state.impact_verification || state.blast_verification,
      )
    ) {
      errors.push(
        "IMPLEMENTING cannot proceed with UNKNOWN impact analysis without persisted impact_verification",
      );
    }
    const criteria = ctx.acceptance_criteria || ctx.acceptanceCriteria;
    if (!criteria || (Array.isArray(criteria) && criteria.length === 0)) {
      errors.push("IMPLEMENTING requires acceptance criteria");
    }
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
    if (state.classification?.diff_clean === true) {
      errors.push(
        "direct execution requires existing non-clean diff (existing-diff-only in PR A)",
      );
    }
    if (ctx.forbid_direct === true) {
      errors.push("direct execution explicitly forbidden");
    }
    // V4: only documentation/formatting — enforced via classification; impact must be trusted LOW
    const impact =
      ctx.impact?.report ||
      ctx.impact ||
      state.impact ||
      ctx.blast?.report ||
      ctx.blast ||
      state.blast;
    if (!isProviderTrustedImpact(impact)) {
      errors.push(
        "direct execution requires a provider-revalidated sealed LOW impact analysis",
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
        assertVerificationGates(data, { ...state, ...policy }, errors, ctx);
      }
    }
  }

  if (from === "VERIFYING" && to === "REVIEWING") {
    const docsSkip = policy.review_level === "none";
    if (!docsSkip && !verificationPolicyExempt(state)) {
      if (
        !verifySealedArtifact(state.provider_verification) ||
        state.provider_verification.ok !== true
      ) {
        errors.push(
          "REVIEWING requires sealed provider_verification from VERIFYING",
        );
      }
    }
  }

  if (to === "FINAL_VERIFYING") {
    if (from !== "REVIEWING") {
      errors.push("FINAL_VERIFYING must follow REVIEWING");
    }
    // Require review approval evidence
    const level = policy.review_level;
    if (level === "unified") {
      const h = ctx.unified_handoff || ctx.review_handoff || state.last_review_handoff;
      const { ok, data, errors: he } = normalizeAndValidateHandoff(
        "unified-reviewer",
        h || {},
      );
      if (!ok || data.verdict !== "APPROVED") {
        errors.push(
          `FINAL_VERIFYING requires unified APPROVED: ${(he || []).map((e) => e.message).join("; ") || data?.verdict}`,
        );
      } else if (canSelfApproveSafe(state, data)) {
        errors.push("no self-approval: reviewer agent matches implementer");
      } else {
        errors.push(...bindReviewerHandoffErrors(data, state, "unified-reviewer"));
      }
    } else if (level === "dual") {
      const spec = normalizeAndValidateHandoff(
        "spec-reviewer",
        ctx.spec_handoff || state.last_spec_handoff || {},
      );
      const code = normalizeAndValidateHandoff(
        "code-reviewer",
        ctx.code_handoff || state.last_code_handoff || {},
      );
      if (!spec.ok || spec.data.verdict !== "APPROVED") {
        errors.push("FINAL_VERIFYING requires spec-reviewer APPROVED");
      } else {
        errors.push(...bindReviewerHandoffErrors(spec.data, state, "spec-reviewer"));
      }
      if (!code.ok || code.data.verdict !== "APPROVED") {
        errors.push("FINAL_VERIFYING requires code-reviewer APPROVED");
      } else {
        errors.push(...bindReviewerHandoffErrors(code.data, state, "code-reviewer"));
      }
    }
    if (isMultiTaskRun(state) && !verificationPolicyExempt(state)) {
      const integration = normalizeAndValidateHandoff(
        "integration-reviewer",
        ctx.integration_handoff || state.last_integration_handoff || {},
      );
      if (!integration.ok || integration.data.verdict !== "APPROVED") {
        errors.push(
          "multi-task FINAL_VERIFYING requires integration-reviewer APPROVED",
        );
      } else {
        errors.push(
          ...bindReviewerHandoffErrors(
            integration.data,
            state,
            "integration-reviewer",
          ),
        );
      }
    }
    const high = unresolvedHighFromCtx(ctx, state);
    if (high.length > 0) {
      errors.push(
        `FINAL_VERIFYING blocked by unresolved HIGH findings: ${high.map((f) => f.id).join(", ")}`,
      );
    }
  }

  if (to === "COMPLETED") {
    const level = policy.review_level;
    if (from === "FINAL_VERIFYING") {
      if (ctx.skip_final_verification === true) {
        errors.push("skip_final_verification is not allowed");
      }
      const finalOk =
        verifySealedArtifact(ctx.final_verification) &&
        ctx.final_verification.ok === true;
      if (!finalOk) {
        errors.push(
          "FINAL_VERIFYING → COMPLETED requires provider-sealed final_verification.ok",
        );
      }
      // Stale artifact check
      if (
        state.impact &&
        state.impact.provider_validated === true &&
        state.impact.worktree_head &&
        ctx.worktree
      ) {
        const head = gitRevParse(ctx.worktree, "HEAD");
        if (head && state.impact.worktree_head !== head && !ctx.allow_stale_impact) {
          // Integrated branch may have moved — require fresh final verification only
        }
      }
    } else if (from === "REVIEWING" && !allowsLegacySkipFinal(state, ctx)) {
      // Prefer FINAL_VERIFYING; V3 migration only when run has compatibility_mode:"v3"
      if (level !== "none") {
        errors.push(
          "COMPLETED should follow FINAL_VERIFYING (legacy_skip_final requires persisted compatibility_mode:v3)",
        );
      }
    }
    if (level === "none") {
      if (!["VERIFYING", "REVIEWING", "FINAL_VERIFYING"].includes(from)) {
        errors.push(
          "COMPLETED with review_level none must come from VERIFYING, REVIEWING, or FINAL_VERIFYING",
        );
      }
      const raw = ctx.implementer_handoff || state.last_implementer_handoff;
      if (raw?.legacy_unverified === true && !ctx.allow_legacy_complete) {
        errors.push(
          "legacy_unverified handoff cannot COMPLETE without allow_legacy_complete",
        );
      }
    } else if (
      level === "unified" &&
      from === "REVIEWING" &&
      allowsLegacySkipFinal(state, ctx)
    ) {
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
    } else if (
      level === "dual" &&
      from === "REVIEWING" &&
      allowsLegacySkipFinal(state, ctx)
    ) {
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

function canSelfApproveSafe(state, reviewData) {
  const impl = state.last_implementer_handoff?.agent;
  const rev = reviewData?.agent;
  return impl && rev && impl === rev;
}

function unresolvedHighFromCtx(ctx, state) {
  const findings = [
    ...(ctx.findings || []),
    ...(state.findings || []),
    ...(ctx.integration_handoff?.findings || []),
  ];
  return findings.filter(
    (f) =>
      f &&
      !f.resolved &&
      ["HIGH", "CRITICAL"].includes(String(f.severity || "").toUpperCase()),
  );
}

/**
 * Apply transition; returns { ok, state, errors }.
 */
export function transition(state, to, evidence = {}, providers = null) {
  const prov = providers || createDefaultProviders();
  let ctx = { ...evidence };

  if (
    to === "IMPACT_READY" ||
    to === "DIRECT_IMPLEMENTING" ||
    to === "VERIFYING" ||
    to === "COMPLETED"
  ) {
    const revalidated = revalidateTransitionEvidence(to, ctx, prov, state);
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
    next.tdd_required = requiresTdd(next);
    if (ctx.units != null) next.units = ctx.units;
    if (ctx.execution_units != null) next.execution_units = ctx.execution_units;
    if (ctx.tasks != null) next.tasks = ctx.tasks;
  }
  if (to === "IMPACT_READY") {
    const impact = ctx.impact?.report || ctx.impact || evidence.impact || ctx.blast;
    const report = impact?.report || impact;
    next.impact = report;
    next.blast = report; // legacy mirror
    next = applyImpactEscalation(next, report);
    if (ctx.require_post_impact === true || isAcceptablePreImpact(report)) {
      next.require_post_impact = true;
    }
    const verification =
      ctx.impact_verification ||
      ctx.blast_verification ||
      ctx.verification_evidence ||
      next.impact_verification;
    if (hasExplicitImpactVerification(verification)) {
      next.impact_verification = verification;
      next.blast_verification = verification;
    }
  }
  if (to === "IMPLEMENTING" || to === "DIRECT_IMPLEMENTING") {
    if (ctx.branch) next.branch = ctx.branch;
    if (ctx.current_unit) next.current_unit = ctx.current_unit;
    if (ctx.drift?.plan_commit) next.plan_commit = ctx.drift.plan_commit;
    if (ctx.drift?.current_head) next.head_commit = ctx.drift.current_head;
    if (ctx.current_head) next.head_commit = ctx.current_head;
    if (ctx.impact) next.impact = ctx.impact?.report || ctx.impact;
    if (ctx.blast) next.blast = ctx.blast?.report || ctx.blast;
    if (ctx.graph) next.graph = ctx.graph;
    if (!next.impact && next.blast) next.impact = next.blast;
  }
  if (to === "FINAL_VERIFYING") {
    if (ctx.unified_handoff || ctx.review_handoff) {
      next.last_review_handoff = ctx.unified_handoff || ctx.review_handoff;
    }
    if (ctx.spec_handoff) next.last_spec_handoff = ctx.spec_handoff;
    if (ctx.code_handoff) next.last_code_handoff = ctx.code_handoff;
    if (ctx.integration_handoff) {
      next.last_integration_handoff = ctx.integration_handoff;
    }
  }
  if (to === "VERIFYING") {
    const raw = ctx.implementer_handoff || ctx.handoff;
    if (raw) {
      const { data } = normalizeAndValidateHandoff("implementer", raw);
      next.last_implementer_handoff = data;
      if (data.commit) next.implementer_commit = data.commit;
    }
    if (ctx.provider_verification) {
      next.provider_verification = ctx.provider_verification;
    }
    if (ctx.post_impact) next.post_impact = ctx.post_impact;
    if (ctx.require_post_impact === false) next.require_post_impact = false;
  }
  if (to === "COMPLETED" && ctx.final_verification) {
    next.final_verification = ctx.final_verification;
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
