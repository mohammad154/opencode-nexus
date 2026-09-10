import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { normalizeAndValidateHandoff } from "./migrate-artifacts.js";
import {
  validateBlastReport,
  validateDriftReport,
  validateImpactReport,
  validatePlanAdvisorHandoff,
} from "./schema-validate.js";
import { isPlanCommitAcceptable } from "./drift.js";
import { createDefaultProviders, getAgentCallBudget } from "./providers.js";
import {
  sealProviderArtifact,
  sealArtifact,
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
  maxReview,
  requiresTdd,
  isAcceptablePreImpact,
} from "./policy.js";
import {
  normalizePlanningMode,
  planningModeFromEvidence,
  planAdvisorCallCount,
  validatePlanAdvisorModelDiversity,
} from "./planning.js";
import {
  assertScopeLock,
  assertTransitionScopeLock,
} from "./scope-lock.js";
import {
  isApprovalAdmissible,
  isBlockingFinding,
} from "./review-protocol.js";
import { assertReviewPackageBound } from "./review-package.js";

export const STATES = [
  "CREATED",
  "BRAINSTORMING",
  "WAITING_FOR_USER",
  "PLANNED",
  "TASK_IMPACT_READY",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "FINAL_REVIEWING",
  "FINAL_VERIFYING",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
];

/** Primary happy-path order (task loop re-enters TASK_IMPACT_READY). */
export const LINEAR = [
  "CREATED",
  "BRAINSTORMING",
  "PLANNED",
  "TASK_IMPACT_READY",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "FINAL_REVIEWING",
  "FINAL_VERIFYING",
  "COMPLETED",
];

const TERMINAL = new Set(["COMPLETED", "FAILED"]);
/** @deprecated V5 has no classify gate; kept for import compatibility. */
export const CLASSIFY_APPLY_SOURCE = "classify-apply";

/** Alias for tests/docs that still say IMPACT_READY. */
export const IMPACT_READY = "TASK_IMPACT_READY";

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

/** Seal provider-measured TDD evidence bound to worktree HEAD. */
export function sealTddArtifact(report, worktreeHead = null) {
  return sealProviderArtifact(report, worktreeHead);
}

export { verifySealedArtifact, sealArtifact };


/** @deprecated Use sealImpactArtifact */
export function sealGraphArtifact(graph, worktreeHead = null) {
  return sealImpactArtifact(graph, worktreeHead);
}

/** @deprecated Use sealImpactArtifact */
export function sealBlastArtifact(report, worktreeHead = null) {
  return sealImpactArtifact(report, worktreeHead);
}

const VERIFICATION_STATUSES = new Set([
  "PENDING",
  "RUNNING",
  "PASSED",
  "FAILED",
  "TIMED_OUT",
]);

function verificationPhaseRecord(state, phase) {
  const record = state?.verification;
  if (!record || typeof record !== "object") return null;
  if (record.phase && record.phase !== phase) return null;
  return record;
}

function verificationStatusFor(state, phase) {
  const record = verificationPhaseRecord(state, phase);
  const status = record?.status || state?.verification_status;
  if (VERIFICATION_STATUSES.has(status)) return status;

  // Read-only compatibility inference for pre-lifecycle runs. Migration writes
  // the explicit status on the next state write, but a valid sealed artifact is
  // sufficient to avoid stranding a historical run in memory.
  const field = phase === "FINAL" ? "final_verification" : "provider_verification";
  const artifact = state?.[field];
  return verifySealedArtifact(artifact) && artifact.ok === true
    ? "PASSED"
    : "PENDING";
}

function assertTddEvidenceForReview(state, ctx, errors) {
  if (!requiresTdd(state) || verificationPolicyExempt(state)) return;
  if (ctx.tdd_evidence) {
    errors.push("caller-supplied tdd_evidence rejected — run nexus verify");
  }
  const tddEvidence = state.tdd_evidence;
  if (!tddEvidence || !verifySealedArtifact(tddEvidence)) {
    errors.push("TDD requires provider-sealed TDD evidence report");
    return;
  }
  if (
    !tddEvidence.red ||
    tddEvidence.red.exit_code === 0 ||
    tddEvidence.red.exit_code == null
  ) {
    errors.push("TDD requires red evidence with non-zero exit_code before fix");
  }
  if (!tddEvidence.green || tddEvidence.green.exit_code !== 0) {
    errors.push("TDD requires green evidence with exit_code 0 after fix");
  }
  if (tddEvidence.ok !== true) {
    errors.push("provider TDD verification failed");
  }
  const worktree = ctx.worktree || state.worktree;
  if (worktree && tddEvidence.worktree_head) {
    const head = gitRevParse(worktree, "HEAD");
    if (head && tddEvidence.worktree_head !== head) {
      errors.push("tdd_evidence worktree_head mismatch with current HEAD");
    }
  }
}

/**
 * Authorization gates consume only evidence durably written by `nexus verify`.
 * In particular, a caller cannot smuggle a digest-shaped provider artifact into
 * a transition: an artifact digest proves integrity, not producer identity.
 */
function assertCompletedVerification(state, ctx, errors, { phase = "TASK" } = {}) {
  const verificationField = phase === "FINAL" ? "final_verification" : "provider_verification";
  const impactField = phase === "FINAL" ? "final_post_impact" : "post_impact";
  if (ctx[verificationField]) {
    errors.push(`caller-supplied ${verificationField} rejected — run nexus verify`);
  }
  if (ctx[impactField]) {
    errors.push(`caller-supplied ${impactField} rejected — run nexus verify`);
  }

  const status = verificationStatusFor(state, phase);
  if (status !== "PASSED") {
    errors.push(`${phase === "FINAL" ? "FINAL_VERIFYING" : "VERIFYING"} verification status must be PASSED (got ${status})`);
  }

  const verification = verificationPhaseRecord(state, phase);
  const artifact = state?.[verificationField];
  if (!verifySealedArtifact(artifact) || artifact.ok !== true) {
    errors.push(`${phase === "FINAL" ? "COMPLETED" : "REVIEWING"} requires sealed ${verificationField}.ok from nexus verify`);
  }

  const postImpact = state?.[impactField];
  if (!verifySealedArtifact(postImpact)) {
    errors.push(`${phase === "FINAL" ? "COMPLETED" : "REVIEWING"} requires sealed ${impactField} from nexus verify`);
  }

  const worktree = ctx.worktree || state?.worktree;
  if (worktree) {
    const head = gitRevParse(worktree, "HEAD");
    for (const [label, candidate] of [
      [verificationField, artifact],
      [impactField, postImpact],
    ]) {
      if (head && candidate?.worktree_head !== head) {
        errors.push(`${label} worktree_head mismatch with current HEAD`);
      }
    }
    if (head && verification?.worktree_head && verification.worktree_head !== head) {
      errors.push("verification worktree_head mismatch with current HEAD");
    }
  }

  if (
    verification?.worktree_head &&
    artifact?.worktree_head &&
    verification.worktree_head !== artifact.worktree_head
  ) {
    errors.push("verification summary does not match provider verification HEAD");
  }
  if (
    verification?.worktree_head &&
    postImpact?.worktree_head &&
    verification.worktree_head !== postImpact.worktree_head
  ) {
    errors.push("verification summary does not match post-impact HEAD");
  }

  if (phase === "TASK") assertTddEvidenceForReview(state, ctx, errors);
  if (
    phase === "TASK" &&
    state.tdd_evidence &&
    verification?.worktree_head &&
    state.tdd_evidence.worktree_head !== verification.worktree_head
  ) {
    errors.push("verification summary does not match TDD evidence HEAD");
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

function gitDirtyPaths(worktree) {
  if (!worktree) return [];
  const result = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: worktree, encoding: "utf8" },
  );
  if (result.status !== 0) return [];
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((file) => file.replace(/^"|"$/g, ""));
}

export function requiredEvidence(from, to) {
  const map = {
    "CREATED->BRAINSTORMING": [],
    "BRAINSTORMING->WAITING_FOR_USER": ["question"],
    "WAITING_FOR_USER->BRAINSTORMING": [],
    "BRAINSTORMING->PLANNED": ["plan_path", "plan_check"],
    "PLANNED->TASK_IMPACT_READY": ["impact"],
    "TASK_IMPACT_READY->IMPLEMENTING": [
      "branch",
      "impact",
      "acceptance_criteria",
      "drift",
    ],
    "IMPLEMENTING->VERIFYING": ["implementer_handoff"],
    "VERIFYING->REVIEWING": ["provider_verification"],
    "REVIEWING->TASK_IMPACT_READY": ["review_handoff"],
    "REVIEWING->FINAL_REVIEWING": ["review_handoff", "review_package"],
    "REVIEWING->FINAL_VERIFYING": ["review_handoff", "review_package"],
    "FINAL_REVIEWING->FINAL_VERIFYING": ["review_handoff", "review_package"],
    "FINAL_REVIEWING->TASK_IMPACT_READY": ["review_handoff"],
    "FINAL_VERIFYING->COMPLETED": ["final_verification"],
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
  if (role && data?.agent && data.agent !== role) {
    errors.push(
      `${role} handoff agent mismatch (got ${data.agent}, want ${role})`,
    );
  }
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

function wantsNextTask(ctx, state) {
  return (
    ctx.next_task === true ||
    ctx.more_tasks === true ||
    Boolean(ctx.next_unit) ||
    Boolean(ctx.current_unit && ctx.current_unit !== state.current_unit)
  );
}

function planAdvisorEvidence(ctx = {}, state = {}) {
  return (
    ctx.plan_advisor_handoff ||
    ctx.plan_advisor ||
    state.plan_advisor_handoff ||
    state.plan_advisor ||
    null
  );
}

function planningModeFromContext(ctx = {}, state = {}) {
  const classification = {
    ...(state.classification || {}),
    ...(ctx.classification || {}),
  };
  return planningModeFromEvidence({
    ...classification,
    ...state,
    ...ctx,
    planning_mode:
      ctx.planning_mode ||
      ctx.planningMode ||
      state.planning_mode ||
      ctx.plan_check?.planning_mode,
    files_changed:
      ctx.files_changed ??
      ctx.filesChanged ??
      classification.files_changed ??
      classification.filesChanged,
    estimated_lines:
      ctx.estimated_lines ??
      ctx.estimatedLines ??
      classification.estimated_lines ??
      classification.estimatedLines,
    change_class:
      ctx.change_class ||
      ctx.changeClass ||
      classification.change_class ||
      state.change_class,
  });
}

function planAdvisorCallsFromContext(ctx = {}, state = {}) {
  const evidence = planAdvisorEvidence(ctx, state);
  if (Number.isFinite(Number(evidence?.calls))) {
    return Math.max(0, Math.floor(Number(evidence.calls)));
  }
  if (evidence?.called === false) return 0;
  if (evidence) return 1;
  if (Number.isFinite(Number(ctx.plan_advisor_calls))) {
    return Math.max(0, Math.floor(Number(ctx.plan_advisor_calls)));
  }
  if (Number.isFinite(Number(state.plan_advisor_calls))) {
    return Math.max(0, Math.floor(Number(state.plan_advisor_calls)));
  }
  return 0;
}

function hasCriticalPlanDisagreement(ctx = {}, advisor = null) {
  return Boolean(
    ctx.critical_disagreement === true ||
      ctx.criticalDisagreement === true ||
      advisor?.critical_disagreement === true ||
      advisor?.criticalDisagreement === true ||
      advisor?.verdict === "CRITICAL_DISAGREEMENT" ||
      advisor?.plan_verdict === "CRITICAL_DISAGREEMENT",
  );
}

function finalReviewReuseRequested(ctx = {}) {
  return Boolean(
    ctx.reuse_final_review === true ||
      ctx.single_unit_final_review_reuse === true ||
      ctx.final_review_reuse === true,
  );
}

function currentReviewTip(state, ctx = {}) {
  // Final-review reuse is a provenance-sensitive shortcut. A persisted
  // implementer commit is not a substitute for recomputing the current tip
  // from the bound worktree.
  return ctx.worktree ? gitRevParse(ctx.worktree, "HEAD") : null;
}

function reviewerWorkspaceMutationErrors(worktree) {
  if (!worktree) return [];
  const dirtyCode = gitDirtyPaths(worktree).filter(
    (file) => !file.startsWith(".opencode/"),
  );
  return dirtyCode.length > 0
    ? [`reviewer approval rejected: workspace changed outside .opencode (${dirtyCode.join(", ")})`]
    : [];
}

function stateUnitCount(state = {}) {
  const candidate = state.execution_units ?? state.units ?? state.tasks;
  if (Array.isArray(candidate)) return candidate.length;
  if (Number.isFinite(Number(candidate))) return Math.floor(Number(candidate));
  if (Number.isFinite(Number(state.task_count))) return Math.floor(Number(state.task_count));
  return null;
}

function singleUnitReuseErrors(state, ctx, handoff, reviewPackage) {
  const errors = [];
  if (!ctx.worktree) {
    errors.push(
      "single-unit final-review reuse requires a bound worktree for HEAD and digest verification",
    );
  }
  if (stateUnitCount(state) !== 1) {
    errors.push(
      "single-unit final-review reuse is allowed only when the run has exactly one execution unit",
    );
  }
  if (wantsNextTask(ctx, state)) {
    errors.push("single-unit final-review reuse cannot be used when more tasks remain");
  }
  if (ctx.code_changed_after_review === true || ctx.digest_unchanged === false) {
    errors.push("single-unit final-review reuse requires unchanged code after task review");
  }
  if (ctx.worktree) {
    const dirtyCode = gitDirtyPaths(ctx.worktree).filter(
      (file) => !file.startsWith(".opencode/"),
    );
    if (dirtyCode.length > 0) {
      errors.push(
        `single-unit final-review reuse rejected: code changed after review (${dirtyCode.join(", ")})`,
      );
    }
  }
  if (!reviewPackage || typeof reviewPackage !== "object") {
    errors.push("single-unit final-review reuse requires the task review package");
  } else {
    if (reviewPackage.scope !== "task") {
      errors.push('single-unit final-review reuse requires review_package.scope "task"');
    }
    if (!reviewPackage.digest_sha256) {
      errors.push("single-unit final-review reuse requires review_package.digest_sha256");
    }
  }
  const tip = currentReviewTip(state, ctx);
  if (!tip) {
    errors.push("single-unit final-review reuse requires a verifiable final HEAD");
  } else if (!handoff?.reviewed_commit || handoff.reviewed_commit !== tip) {
    errors.push(
      `single-unit final-review reuse requires reviewed_commit to equal final HEAD (got ${handoff?.reviewed_commit || "missing"}, want ${tip})`,
    );
  }
  if (reviewPackage?.head_commit && tip && reviewPackage.head_commit !== tip) {
    errors.push(
      `single-unit final-review reuse requires review_package.head_commit to equal final HEAD (got ${reviewPackage.head_commit}, want ${tip})`,
    );
  }
  return errors;
}

function validateReviewerApproval(handoff, state, ctx, {
  expectedScope,
  label,
}) {
  const errors = [];
  const {
    ok,
    data,
    errors: he,
  } = normalizeAndValidateHandoff("reviewer", handoff || {});
  if (!ok || data.verdict !== "APPROVED") {
    errors.push(
      `${label} requires reviewer APPROVED: ${(he || []).map((e) => e.message).join("; ") || data?.verdict}`,
    );
    return { ok: false, errors, data };
  }
  if (data.agent && data.agent !== "reviewer") {
    errors.push(`review requires agent "reviewer", got "${data.agent}"`);
  }
  if ((data.review_scope || "task") !== expectedScope) {
    errors.push(
      `${label} requires review_scope "${expectedScope}" (got ${data.review_scope || "task"})`,
    );
  }
  errors.push(...bindReviewerHandoffErrors(data, state, "reviewer"));
  const pkg = ctx.review_package || state.review_package;
  const adm = isApprovalAdmissible(data, state, {
    review_package: pkg,
    review_scope: expectedScope,
  });
  if (!adm.ok) {
    errors.push(...adm.errors.map((e) => `approval not admissible: ${e}`));
  }
  if (canSelfApproveSafe(state, data, ctx)) {
    errors.push("no self-approval: reviewer agent matches implementer");
  }
  errors.push(...reviewerWorkspaceMutationErrors(ctx.worktree));
  const pkgCheck = assertReviewPackageBound(pkg, {
    scope: expectedScope,
    worktree: ctx.worktree,
    state,
    handoff: data,
    requireDigest: Boolean(ctx.worktree),
  });
  if (!pkgCheck.ok) {
    errors.push(...pkgCheck.errors.map((e) => `${label}: ${e}`));
  }
  return { ok: errors.length === 0, errors, data };
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
    if (!Array.isArray(data.verification_gates) || data.verification_gates.length === 0) {
      errors.push("VERIFYING requires non-empty verification_gates");
    } else {
      const failedGate = data.verification_gates.find(
        (gate) => !gate || typeof gate !== "object" || gate.pass !== true,
      );
      if (failedGate) {
        errors.push("all verification_gates must have pass: true");
      }
    }
    if (data.tests && !Array.isArray(data.tests) && data.tests.passed !== true) {
      errors.push("tests.passed must be true when tests is an object");
    }
    if (
      Array.isArray(data.tests) &&
      data.tests.some(
        (test) =>
          test &&
          typeof test === "object" &&
          Object.prototype.hasOwnProperty.call(test, "passed") &&
          test.passed !== true,
      )
    ) {
      errors.push("all structured tests must have passed: true");
    }
    const impactOk =
      (data.impact && data.impact.verified === true) ||
      (data.blast && data.blast.verified === true);
    if (!impactOk) {
      errors.push(
        "impact.verified (or legacy blast.verified) must be true when impact verification is required",
      );
    }
    if (!data.drift_check || typeof data.drift_check !== "object") {
      errors.push("VERIFYING requires drift_check");
    } else if (data.drift_check.pass !== true) {
      errors.push("drift_check.pass must be true");
    }
  }

  // Provider execution, post-impact, and TDD measurement deliberately happen
  // after the fast state transition via `nexus verify`. Their sealed evidence
  // is consumed only by the later VERIFYING → REVIEWING authorization gate.
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

  if (to === "TASK_IMPACT_READY" || to === "IMPACT_READY") {
    if (providers?.impactProvider?.analyze) {
      const analyzed = providers.impactProvider.analyze({
        worktree,
        reportPath: ctx.impact_path || ctx["impact-path"] || ctx.blast_path,
        base: ctx.base,
        change_class:
          ctx.change_class ||
          ctx.classification?.change_class ||
          state.classification?.change_class ||
          state.change_class,
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
      } else {
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
      } else {
        errors.push(
          `impact provider rejected artifact: ${analyzed?.error || "not ok"}`,
        );
      }
    } else if (ctx.impact || ctx.blast) {
      const report =
        ctx.impact?.report || ctx.impact || ctx.blast?.report || ctx.blast;
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
  // Normalize legacy alias before unknown-state check
  if (to === "IMPACT_READY") to = "TASK_IMPACT_READY";
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

  // Normalize legacy IMPACT_READY alias (already done at top; keep idempotent)
  if (to === "IMPACT_READY") to = "TASK_IMPACT_READY";

  const allowed = new Set();
  if (from === "CREATED") allowed.add("BRAINSTORMING");
  if (from === "BRAINSTORMING") {
    allowed.add("WAITING_FOR_USER");
    allowed.add("PLANNED");
  }
  if (from === "WAITING_FOR_USER") allowed.add("BRAINSTORMING");
  if (from === "PLANNED") allowed.add("TASK_IMPACT_READY");
  if (from === "TASK_IMPACT_READY") allowed.add("IMPLEMENTING");
  if (from === "IMPLEMENTING") allowed.add("VERIFYING");
  if (from === "VERIFYING") allowed.add("REVIEWING");
  if (from === "REVIEWING") {
    allowed.add("TASK_IMPACT_READY"); // REQUEST_CHANGES fix loop or next task
    allowed.add("FINAL_REVIEWING"); // last task APPROVED → whole-branch review
    // A single-unit task review may be reused for final verification only
    // after the caller explicitly opts in; all evidence checks still apply.
    if (finalReviewReuseRequested(ctx)) allowed.add("FINAL_VERIFYING");
  }
  if (from === "FINAL_REVIEWING") {
    allowed.add("FINAL_VERIFYING"); // final-scope APPROVED
    allowed.add("TASK_IMPACT_READY"); // REQUEST_CHANGES on final review
  }
  if (from === "FINAL_VERIFYING") allowed.add("COMPLETED");
  if (from === "BLOCKED") {
    const resumeTarget = state.blocked_from || state.resume_state;
    if (
      resumeTarget &&
      STATES.includes(resumeTarget) &&
      !TERMINAL.has(resumeTarget)
    ) {
      allowed.add(resumeTarget);
    }
  }
  allowed.add("BLOCKED");
  allowed.add("FAILED");

  if (!allowed.has(to)) {
    errors.push(`illegal transition ${from} → ${to}`);
    return { ok: false, errors };
  }

  if (to === "BRAINSTORMING") {
    // No evidence required — optional notes only
  }

  if (to === "WAITING_FOR_USER") {
    const q = ctx.question || ctx.user_question || ctx.clarifying_question;
    if (!q || (typeof q === "string" && !q.trim())) {
      errors.push("WAITING_FOR_USER requires a clarifying question");
    }
  }

  if (to === "PLANNED") {
    const adminSkip =
      (ctx.plan_skip === true || ctx.planSkip === true) &&
      (state.compatibility_mode === "v3-admin" ||
        ctx.compatibility_mode === "v3-admin" ||
        ctx.admin_plan_skip === true);
    const planOk =
      adminSkip ||
      ctx.plan_exists === true ||
      exists(ctx.plan_path) ||
      (ctx.worktree &&
        exists(path.join(ctx.worktree, ".opencode", "plans", "PLAN.md")));
    if (!planOk) {
      errors.push(
        "PLANNED requires .opencode/plans/PLAN.md (plan_skip only with admin/compatibility mode)",
      );
    }
    const planningMode =
      planningModeFromContext(ctx, state) ||
      normalizePlanningMode(state.planning_mode, "compact");
    const advisor = planAdvisorEvidence(ctx, state);
    if (planningMode !== "compact" && !advisor) {
      errors.push(
        `planning mode ${planningMode} requires one independent plan-advisor handoff before PLANNED`,
      );
    }
    const advisorCalls = planAdvisorCallsFromContext(ctx, state);
    const allowedAdvisorCalls = planAdvisorCallCount(planningMode, {
      criticalDisagreement: hasCriticalPlanDisagreement(ctx, advisor),
    });
    if (advisorCalls > allowedAdvisorCalls) {
      errors.push(
        `planning mode ${planningMode} permits ${allowedAdvisorCalls} plan-advisor call(s); got ${advisorCalls}`,
      );
    }
    if (planningMode !== "compact" && advisorCalls < 1) {
      errors.push(
        `planning mode ${planningMode} requires at least one completed plan-advisor call`,
      );
    }
    if (planningMode === "compact" && advisorCalls > 0) {
      errors.push("compact planning must not spend a plan-advisor call");
    }
    if (advisor) {
      const advisorSchema = validatePlanAdvisorHandoff(advisor);
      if (!advisorSchema.ok) {
        errors.push(
          `plan-advisor handoff schema invalid: ${advisorSchema.errors
            .map((error) => `${error.path} ${error.message}`)
            .join("; ")}`,
        );
      }
      if (advisor.agent !== "plan-advisor") {
        errors.push(
          `plan advisor handoff agent must be "plan-advisor" (got "${advisor.agent || "missing"}")`,
        );
      }
      if (advisor.read_only !== true || advisor.wrote_production_code === true) {
        errors.push("plan-advisor handoff must explicitly prove read_only=true and cannot write production code");
      }
      const diversity = validatePlanAdvisorModelDiversity({
        orchestratorModel:
          ctx.orchestrator_model || ctx.orchestratorModel || state.orchestrator_model,
        planAdvisorModel:
          advisor.model || ctx.plan_advisor_model || ctx.planAdvisorModel,
      });
      if (!diversity.ok) errors.push(diversity.error);
    }
    const planCheck = ctx.plan_check || state.plan_check;
    if (!adminSkip && planCheck?.ok !== true) {
      errors.push(
        "PLANNED requires a passing deterministic plan-check report (use transition --plan-check)",
      );
    }
    if (!adminSkip && ctx.plan_check?.ok === false) {
      errors.push("PLANNED rejects a failed plan-check report");
    }
  }

  if (to === "TASK_IMPACT_READY") {
    // Fresh pre-impact required every time (including after REQUEST_CHANGES)
    const impact =
      ctx.impact?.report ||
      ctx.impact ||
      state.impact ||
      ctx.blast ||
      state.blast;
    const report = impact?.report || impact;
    // When coming from REVIEWING / FINAL_REVIEWING, require a new impact in ctx
    if (from === "REVIEWING" || from === "FINAL_REVIEWING") {
      const fresh = ctx.impact?.report || ctx.impact || ctx.blast;
      if (!fresh) {
        errors.push(
          "TASK_IMPACT_READY after review requires fresh impact evidence (every implementer dispatch needs re-impact)",
        );
      }
      const reviewRaw =
        ctx.review_handoff ||
        ctx.unified_handoff ||
        ctx.request_changes_handoff ||
        state.last_review_handoff;
      if (!reviewRaw) {
        errors.push(
          `${from} → TASK_IMPACT_READY requires review_handoff (REQUEST_CHANGES or next-task APPROVED)`,
        );
      } else {
        const {
          ok,
          data,
          errors: he,
        } = normalizeAndValidateHandoff("reviewer", reviewRaw);
        if (!ok) {
          errors.push(
            `review handoff invalid: ${(he || []).map((e) => e.message).join("; ")}`,
          );
        } else if (
          data.verdict !== "REQUEST_CHANGES" &&
          data.verdict !== "APPROVED"
        ) {
          errors.push(
            `${from} → TASK_IMPACT_READY requires REQUEST_CHANGES or APPROVED (next task), got ${data.verdict}`,
          );
        } else if (data.verdict === "APPROVED" && from === "FINAL_REVIEWING") {
          errors.push(
            "FINAL_REVIEWING APPROVED must go to FINAL_VERIFYING (use REQUEST_CHANGES for fix loops)",
          );
        } else if (data.verdict === "APPROVED" && !wantsNextTask(ctx, state)) {
          errors.push(
            "APPROVED review returning to TASK_IMPACT_READY requires next_task/more_tasks or a new current_unit",
          );
        } else if (data.verdict === "APPROVED") {
          if ((data.review_scope || "task") === "final") {
            errors.push(
              'next-task APPROVED must use review_scope "task"',
            );
          }
          const pkg = ctx.review_package || state.review_package;
          const adm = isApprovalAdmissible(data, state, {
            review_package: pkg,
            review_scope: "task",
          });
          if (!adm.ok) {
            errors.push(...adm.errors.map((e) => `approval not admissible: ${e}`));
          }
          errors.push(...bindReviewerHandoffErrors(data, state, "reviewer"));
        }
      }
    }
    if (report?.fabricated === true) {
      errors.push("TASK_IMPACT_READY rejects fabricated impact trust labels");
    }
    if (report?.trusted === true && !verifySealedArtifact(report)) {
      errors.push(
        "TASK_IMPACT_READY rejects unsealed trusted impact; provider revalidation required",
      );
    }
    const impactForGate =
      from === "REVIEWING" || from === "FINAL_REVIEWING"
        ? ctx.impact?.report || ctx.impact || ctx.blast || report
        : report;
    if (!impactForGate) {
      errors.push("TASK_IMPACT_READY requires impact provider result");
    } else {
      const normalized = {
        uncertainties: [],
        dimensions: {},
        confidence: impactForGate.confidence ?? 0,
        ...impactForGate,
      };
      if (!normalized.risk && normalized.level)
        normalized.risk = normalized.level;
      const v = validateImpactReport(normalized);
      if (!v.ok) {
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
          "UNKNOWN impact analysis requires explicit impact_verification evidence before TASK_IMPACT_READY",
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
    // Invariant: impact must be bound to current unit / fresh for this dispatch
    if (
      state.impact_consumed_for_implement === true &&
      !ctx.impact &&
      !ctx.blast
    ) {
      errors.push(
        "IMPLEMENTING requires fresh impact — previous impact already consumed (re-run pre-impact)",
      );
    }
    const allowedFiles =
      ctx.allowed_files ||
      state.allowed_files ||
      ctx.implementer_context?.allowed_files ||
      state.implementer_context?.allowed_files ||
      report?.changed_files ||
      report?.planned_targets;
    const normalizedAllowed = Array.isArray(allowedFiles)
      ? allowedFiles.filter((f) => typeof f === "string" && f.trim())
      : [];
    if (normalizedAllowed.length === 0) {
      errors.push(
        "IMPLEMENTING requires non-empty allowed_files (persist scope before implementer dispatch)",
      );
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
        const scopeLock = assertTransitionScopeLock({
          state,
          ctx,
          handoffData: data,
        });
        if (!scopeLock.ok) {
          errors.push(
            `scope lock check failed: ${scopeLock.code} (extras: ${(scopeLock.extras || []).join(", ")}) — ${scopeLock.message}`,
          );
        }
      }
    }
  }

  if (to === "REVIEWING") {
    if (!verificationPolicyExempt(state)) {
      assertCompletedVerification(state, ctx, errors, { phase: "TASK" });
    }
  }

  if (to === "FINAL_REVIEWING") {
    if (from !== "REVIEWING" && from !== "BLOCKED") {
      errors.push("FINAL_REVIEWING must follow REVIEWING");
    }
    const h =
      ctx.review_handoff || ctx.unified_handoff || state.last_review_handoff;
    const validated = validateReviewerApproval(h, state, ctx, {
      expectedScope: "task",
      label: "FINAL_REVIEWING",
    });
    errors.push(...validated.errors);
    if (wantsNextTask(ctx, state)) {
      errors.push(
        "FINAL_REVIEWING is only for the last task (omit next_task/more_tasks)",
      );
    }
    const high = unresolvedHighFromCtx(ctx, state);
    if (high.length > 0) {
      errors.push(
        `FINAL_REVIEWING blocked by unresolved findings: ${high.map((f) => f.id).join(", ")}`,
      );
    }
  }

  if (to === "FINAL_VERIFYING") {
    const reuse = from === "REVIEWING" && finalReviewReuseRequested(ctx);
    if (!reuse && from !== "FINAL_REVIEWING" && from !== "BLOCKED") {
      errors.push("FINAL_VERIFYING must follow FINAL_REVIEWING");
    }
    const h =
      ctx.review_handoff || ctx.unified_handoff || state.last_review_handoff;
    const validated = validateReviewerApproval(h, state, ctx, {
      expectedScope: reuse ? "task" : "final",
      label: reuse ? "SINGLE_UNIT_FINAL_REVIEW_REUSE" : "FINAL_VERIFYING",
    });
    errors.push(...validated.errors);
    if (reuse) {
      errors.push(
        ...singleUnitReuseErrors(
          state,
          ctx,
          validated.data,
          ctx.review_package || state.review_package,
        ),
      );
    }
    if (
      !reuse && from === "FINAL_REVIEWING" &&
      !state.last_task_review_handoff &&
      !ctx.task_review_handoff
    ) {
      // Entering FINAL_REVIEWING should have persisted last_task_review_handoff;
      // when resuming from BLOCKED, accept prior task approval on state.
      errors.push(
        "FINAL_VERIFYING requires a prior task-scope approval (last_task_review_handoff)",
      );
    }
    const high = unresolvedHighFromCtx(ctx, state);
    if (high.length > 0) {
      errors.push(
        `FINAL_VERIFYING blocked by unresolved findings: ${high.map((f) => f.id).join(", ")}`,
      );
    }
  }

  if (to === "COMPLETED") {
    if (from !== "FINAL_VERIFYING" && from !== "BLOCKED") {
      errors.push("COMPLETED must follow FINAL_VERIFYING");
    }
    if (ctx.skip_final_verification === true) {
      errors.push("skip_final_verification is not allowed");
    }
    if (from === "FINAL_VERIFYING") {
      assertCompletedVerification(state, ctx, errors, { phase: "FINAL" });
    }
  }

  return { ok: errors.length === 0, errors };
}

function getImplementerAgent(state, ctx = {}) {
  return (
    ctx.implementer_handoff?.agent ||
    ctx.last_implementer_handoff?.agent ||
    state?.last_implementer_handoff?.agent ||
    state?.implementer_agent ||
    "implementer"
  );
}

function canSelfApproveSafe(state, reviewData, ctx = {}) {
  const impl = getImplementerAgent(state, ctx);
  const rev = reviewData?.agent;
  return Boolean(impl && rev && impl === rev);
}

function unresolvedHighFromCtx(ctx, state) {
  const review =
    ctx.review_handoff || ctx.unified_handoff || state.last_review_handoff;
  const findings = [
    ...(ctx.findings || []),
    ...(state.findings || []),
    ...(ctx.integration_handoff?.findings || []),
    ...(review?.findings || []),
    ...(state.pending_review_findings || []),
    ...(state.last_review_handoff?.findings || []),
  ];
  return findings.filter(isBlockingFinding);
}

function agentCallsForTransition(from, to, state, ctx) {
  // Charge when an agent phase completes / starts requiring a discrete agent call.
  if (to === "PLANNED" && from === "BRAINSTORMING") {
    const count = planAdvisorCallsFromContext(ctx, state);
    return count > 0
      ? { count, agent: "plan-advisor" }
      : { count: 0, agent: null };
  }
  if (to === "VERIFYING" && from === "IMPLEMENTING") {
    return { count: 1, agent: "implementer" };
  }
  if (to === "FINAL_VERIFYING" && from === "REVIEWING") {
    // This is the task reviewer call; the final-review call is intentionally
    // absent because the task package is being reused under strict binding.
    return { count: 1, agent: "reviewer" };
  }
  if (
    to === "FINAL_VERIFYING" ||
    to === "FINAL_REVIEWING" ||
    (to === "TASK_IMPACT_READY" &&
      (from === "REVIEWING" || from === "FINAL_REVIEWING"))
  ) {
    const h =
      ctx.review_handoff || ctx.unified_handoff || state.last_review_handoff;
    if (h || to === "FINAL_VERIFYING" || to === "FINAL_REVIEWING") {
      return { count: 1, agent: "reviewer" };
    }
  }
  if (to === "IMPLEMENTING") {
    return { count: 0, agent: null };
  }
  return { count: 0, agent: null };
}

function assertAgentCallBudget(state, to, ctx = {}) {
  const from = state.state;
  const charge = agentCallsForTransition(from, to, state, ctx);
  if (!charge.count) return { ok: true, used: state.agent_calls_used || 0 };

  const unitCandidate =
    to === "PLANNED"
      ? ctx.execution_units ?? ctx.units ?? ctx.tasks ?? ctx.task_count
      : state.execution_units ?? state.units ?? state.tasks ?? state.task_count;
  const units = Array.isArray(unitCandidate)
    ? unitCandidate.length || 1
    : Number(unitCandidate) > 0
      ? Math.floor(Number(unitCandidate))
      : 1;
  const planningAdvisorCalls = Math.max(
    Number(state.plan_advisor_calls) || 0,
    planAdvisorCallsFromContext(ctx, state),
  );
  const budget = getAgentCallBudget({
    units,
    maxCalls: state.agent_call_budget?.max_calls,
    planningAdvisorCalls,
  });
  const used = Number.isInteger(state.agent_calls_used) ? state.agent_calls_used : 0;
  if (used + charge.count > budget.max_calls) {
    return {
      ok: false,
      errors: [
        `AGENT_CALL_BUDGET_EXCEEDED: used ${used}+${charge.count} > max ${budget.max_calls} (${budget.category})`,
      ],
      used,
      budget,
      charge,
    };
  }
  return { ok: true, used: used + charge.count, budget, charge };
}

/**
 * Validate the implementer contract before any VERIFYING provider is run.
 * This prevents malformed handoffs from triggering tests or post-impact work.
 */
export function preflightImplementerHandoff(ctx = {}) {
  const raw = ctx.implementer_handoff || ctx.handoff;
  if (!raw) return ["VERIFYING requires implementer handoff"];
  const normalized = normalizeAndValidateHandoff("implementer", raw);
  const errors = normalized.ok
    ? []
    : [
        `implementer handoff invalid: ${(normalized.errors || [])
          .map((error) => error.message)
          .join("; ")}`,
      ];
  if (
    normalized.ok &&
    !["DONE", "DONE_WITH_CONCERNS"].includes(normalized.data?.status)
  ) {
    errors.push(
      `implementer status must be DONE*, got ${normalized.data?.status}`,
    );
  }
  return errors;
}

/**
 * Apply transition; returns { ok, state, errors }.
 */
export function transition(state, to, evidence = {}, providers = null) {
  const prov = providers || createDefaultProviders();
  let ctx = { ...evidence };
  if (to === "IMPACT_READY") to = "TASK_IMPACT_READY";

  if (to === "VERIFYING") {
    const preflightErrors = preflightImplementerHandoff(ctx);
    if (preflightErrors.length) {
      return {
        ok: false,
        state,
        errors: preflightErrors,
        blocked_from: state?.state || null,
        block_code: "INVALID_IMPLEMENTER_HANDOFF",
      };
    }
  }

  // Transitions authorize state only. Expensive post-impact, TDD, and test
  // execution are owned by the explicit, resumable `nexus verify` command.
  if (to === "TASK_IMPACT_READY") {
    const revalidated = revalidateTransitionEvidence(to, ctx, prov, state);
    ctx = revalidated.ctx;
    if (revalidated.errors.length) {
      return { ok: false, state, errors: revalidated.errors };
    }
  }

  const check = canTransition(state, to, ctx);
  if (!check.ok) return { ok: false, state, errors: check.errors };

  const budgetCheck = assertAgentCallBudget(state, to, ctx);
  if (!budgetCheck.ok) {
    return { ok: false, state, errors: budgetCheck.errors };
  }

  let next = {
    ...state,
    state: to,
    updated_at: nowIso(),
    agent_calls_used: budgetCheck.used,
    agent_call_budget: budgetCheck.budget || state.agent_call_budget || null,
    transitions: [
      ...(state.transitions || []),
      {
        from: state.state,
        to,
        at: nowIso(),
        evidence: evidence.evidence_path || evidence.evidence || null,
        ...(budgetCheck.charge?.count
          ? {
              agent_calls: budgetCheck.charge.count,
              agent: budgetCheck.charge.agent,
            }
          : {}),
      },
    ],
  };

  if (budgetCheck.charge?.count) {
    prov.telemetry?.emit?.({
      event: "agent_call",
      run_id: state.run_id,
      agent: budgetCheck.charge.agent,
      from: state.state,
      to,
      call_count: budgetCheck.charge.count,
      agent_calls_used: budgetCheck.used,
      budget_max: budgetCheck.budget?.max_calls,
    });
  }

  if (to === "BRAINSTORMING") {
    if (ctx.notes) next.brainstorm_notes = ctx.notes;
    const planningMode = planningModeFromContext(ctx, state);
    if (planningMode) next.planning_mode = planningMode;
    if (ctx.classification) next.classification = ctx.classification;
    if (ctx.change_class || ctx.changeClass) {
      next.change_class = ctx.change_class || ctx.changeClass;
    }
    const advisor = planAdvisorEvidence(ctx, state);
    if (advisor) {
      next.plan_advisor = advisor;
      next.plan_advisor_handoff = advisor;
    }
    if (ctx.question || ctx.user_question) {
      next.last_user_question = ctx.question || ctx.user_question;
    }
  }
  if (to === "WAITING_FOR_USER") {
    next.last_user_question =
      ctx.question || ctx.user_question || ctx.clarifying_question || null;
  }
  if (to === "PLANNED") {
    if (ctx.tasks != null) next.tasks = ctx.tasks;
    if (ctx.units != null) next.units = ctx.units;
    if (ctx.execution_units != null) next.execution_units = ctx.execution_units;
    const planningMode = planningModeFromContext(ctx, state);
    if (planningMode) next.planning_mode = planningMode;
    const advisor = planAdvisorEvidence(ctx, state);
    if (advisor) {
      next.plan_advisor = advisor;
      next.plan_advisor_handoff = advisor;
      next.plan_advisor_calls = planAdvisorCallsFromContext(ctx, state);
    }
    if (ctx.plan_check != null) next.plan_check = ctx.plan_check;
    if (ctx.change_class) next.change_class = ctx.change_class;
    if (ctx.tdd_required === true) next.tdd_required = true;
    else next.tdd_required = requiresTdd(next);
  }
  if (to === "TASK_IMPACT_READY") {
    const impact =
      ctx.impact?.report || ctx.impact || evidence.impact || ctx.blast;
    const report = impact?.report || impact;
    next.impact = report;
    next.blast = report; // legacy mirror
    next = applyImpactEscalation(next, report);
    next.require_post_impact = true;
    next.impact_consumed_for_implement = false;
    const verification =
      ctx.impact_verification ||
      ctx.blast_verification ||
      ctx.verification_evidence ||
      next.impact_verification;
    if (hasExplicitImpactVerification(verification)) {
      next.impact_verification = verification;
      next.blast_verification = verification;
    }
    if (ctx.current_unit || ctx.next_unit) {
      next.current_unit = ctx.next_unit || ctx.current_unit;
    }
    const reviewRaw =
      ctx.review_handoff || ctx.unified_handoff || ctx.request_changes_handoff;
    if (reviewRaw) {
      const { data } = normalizeAndValidateHandoff("reviewer", reviewRaw);
      next.last_review_handoff = data;
      if (data.verdict === "REQUEST_CHANGES") {
        next.pending_review_findings = data.findings || [];
      } else if (data.verdict === "APPROVED") {
        next.pending_review_findings = null;
        const history = Array.isArray(state.task_history)
          ? [...state.task_history]
          : [];
        history.push({
          id: state.current_unit || data.unit_or_task,
          acceptance_criteria: state.acceptance_criteria || [],
          reviewed_commit: data.reviewed_commit,
          verdict: data.verdict,
        });
        next.task_history = history;
      }
    }
  }
  if (to === "IMPLEMENTING") {
    if (ctx.branch) next.branch = ctx.branch;
    if (ctx.current_unit) next.current_unit = ctx.current_unit;
    if (ctx.drift?.plan_commit) next.plan_commit = ctx.drift.plan_commit;
    if (ctx.drift?.current_head) next.head_commit = ctx.drift.current_head;
    if (ctx.current_head) next.head_commit = ctx.current_head;
    // Freeze run base once — whole-branch final review uses this forever.
    const preImplHead =
      ctx.drift?.current_head ||
      ctx.current_head ||
      next.head_commit ||
      state.head_commit ||
      null;
    if (!next.run_base_commit && !state.run_base_commit && preImplHead) {
      next.run_base_commit = preImplHead;
    } else if (state.run_base_commit) {
      next.run_base_commit = state.run_base_commit;
    }
    const criteria = ctx.acceptance_criteria || ctx.acceptanceCriteria;
    if (Array.isArray(criteria) && criteria.length > 0) {
      next.acceptance_criteria = criteria.map(String);
    }
    if (ctx.impact) next.impact = ctx.impact?.report || ctx.impact;
    if (ctx.blast) next.blast = ctx.blast?.report || ctx.blast;
    if (ctx.graph) next.graph = ctx.graph;
    if (!next.impact && next.blast) next.impact = next.blast;
    next.impact_consumed_for_implement = true;
    const resolvedAllowed =
      ctx.allowed_files ||
      evidence.allowed_files ||
      state.allowed_files ||
      ctx.implementer_context?.allowed_files ||
      evidence.implementer_context?.allowed_files ||
      next.impact?.changed_files ||
      next.impact?.planned_targets ||
      null;
    if (Array.isArray(resolvedAllowed) && resolvedAllowed.length > 0) {
      next.allowed_files = resolvedAllowed.filter(
        (f) => typeof f === "string" && f.trim(),
      );
    }
    if (ctx.implementer_context || evidence.implementer_context) {
      next.implementer_context =
        ctx.implementer_context || evidence.implementer_context;
    }
    // Attach pending review findings into implementer context for fix loops
    if (state.pending_review_findings?.length) {
      next.implementer_context = {
        ...(next.implementer_context || {}),
        review_findings: state.pending_review_findings,
      };
    }
  }
  if (to === "FINAL_REVIEWING") {
    const raw =
      ctx.review_handoff || ctx.unified_handoff || state.last_review_handoff;
    if (raw) {
      const { data } = normalizeAndValidateHandoff("reviewer", raw);
      next.last_task_review_handoff = data;
      next.last_review_handoff = data;
      const history = Array.isArray(state.task_history)
        ? [...state.task_history]
        : [];
      history.push({
        id: state.current_unit || data.unit_or_task,
        acceptance_criteria: state.acceptance_criteria || [],
        reviewed_commit: data.reviewed_commit,
        verdict: data.verdict,
      });
      next.task_history = history;
    }
    if (ctx.review_package) next.review_package = ctx.review_package;
  }
  if (to === "FINAL_VERIFYING") {
    if (ctx.unified_handoff || ctx.review_handoff) {
      const raw = ctx.unified_handoff || ctx.review_handoff;
      const { data } = normalizeAndValidateHandoff("reviewer", raw);
      next.last_final_review_handoff = data;
      next.last_review_handoff = data;
    }
    if (ctx.review_package) next.review_package = ctx.review_package;
    if (state.state === "REVIEWING" && finalReviewReuseRequested(ctx)) {
      next.final_review_reused = true;
      next.last_final_review_handoff = next.last_review_handoff;
    }
    delete next.final_verification;
    delete next.final_post_impact;
    next.verification_status = "PENDING";
    next.verification = {
      status: "PENDING",
      phase: "FINAL",
      worktree_head: gitRevParse(ctx.worktree || state.worktree, "HEAD"),
      started_at: null,
      completed_at: null,
      plan_digest: null,
      configuration_digest: null,
      artifact_path: null,
      artifact_digest: null,
      current_step: 0,
      total_steps: 0,
      completed_steps: 0,
    };
  }
  if (to === "VERIFYING") {
    const raw = ctx.implementer_handoff || ctx.handoff;
    if (raw) {
      const { data } = normalizeAndValidateHandoff("implementer", raw);
      next.last_implementer_handoff = data;
      if (data.commit) next.implementer_commit = data.commit;
    }
    // Never carry evidence forward from a previous implementation attempt.
    // The new lifecycle only accepts artifacts written by `nexus verify` at
    // this exact implementation HEAD.
    delete next.provider_verification;
    delete next.post_impact;
    delete next.tdd_evidence;
    next.require_post_impact = true;
    next.verification_status = "PENDING";
    next.verification = {
      status: "PENDING",
      phase: "TASK",
      worktree_head:
        next.implementer_commit || gitRevParse(ctx.worktree || state.worktree, "HEAD"),
      started_at: null,
      completed_at: null,
      plan_digest: null,
      configuration_digest: null,
      artifact_path: null,
      artifact_digest: null,
      current_step: 0,
      total_steps: 0,
      completed_steps: 0,
    };
  }

  if (to === "BLOCKED") {
    next.blocked_from =
      state.state === "BLOCKED" ? state.blocked_from || "BLOCKED" : state.state;
    // Ignore caller-forged resume_state — resume only to blocked_from.
    next.resume_state = next.blocked_from;
    next.block_reason =
      ctx.block_reason ||
      ctx.reason ||
      evidence.block_reason ||
      evidence.reason ||
      null;
    next.block_code =
      ctx.block_code ||
      ctx.code ||
      evidence.block_code ||
      evidence.code ||
      null;
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

export { effectivePolicy, maxReview, assertScopeLock, assertTransitionScopeLock };
