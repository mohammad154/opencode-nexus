/**
 * Structured review findings + fix-loop policy + approval admissibility.
 *
 * Nexus — not the LLM — decides whether an APPROVED verdict is gate-valid.
 */

export const MANDATORY_CHECK_CATEGORIES = [
  "correctness",
  "test_quality",
  "impact",
];

/**
 * Reviewer command policy (PR6.A).
 *
 * Deterministic verification is already sealed by `nexus verify` before a
 * reviewer is dispatched. The reviewer's job is semantic and adversarial
 * analysis, so it *consumes* that evidence instead of replaying it:
 *
 *   sealed deterministic evidence → consume, don't replay
 *   → review code / acceptance / impact / tests
 *   → specific new hypothesis? no → no command; yes → focused probe
 *
 * Command execution stays permitted, because a targeted probe can find what the
 * sealed ladder never exercised. What is not permitted is re-running an
 * already-sealed passing command to reconfirm that it passes. Declared probes
 * therefore carry a hypothesis and a reason, and a declared re-run of a sealed
 * passing command that also reports PASS is a redundant replay: it adds latency
 * and no evidence, so it is inadmissible for APPROVED.
 *
 * A probe that contradicts sealed evidence (FAIL / CANNOT_VERIFY) is always
 * admissible — disproving a sealed result is exactly the kind of finding this
 * workflow wants.
 */
export const REVIEWER_COMMAND_POLICY_VERSION = "nexus-reviewer-command-policy/1";

function commandTokens(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  }
  const text = String(value ?? "").trim();
  if (!text) return [];
  return text.split(/\s+/).filter(Boolean);
}

/** Canonical comparable form of a command. Argv order is meaningful. */
export function normalizeCommandKey(value) {
  return commandTokens(value).join(" ");
}

/**
 * Sealed commands available for consumption, from a review package or a sealed
 * verification artifact. Only passing results can make a re-run redundant: a
 * failed or unavailable check is not evidence of anything.
 */
export function sealedCommandIndex(source) {
  const rows = [];
  const push = (entry) => {
    if (!entry || typeof entry !== "object") return;
    const key = normalizeCommandKey(entry.argv?.length ? entry.argv : entry.command);
    if (!key) return;
    rows.push({
      id: typeof entry.id === "string" ? entry.id : null,
      command: key,
      pass: entry.pass === true,
      status: typeof entry.status === "string" ? entry.status : null,
      identity: typeof entry.identity === "string" ? entry.identity : null,
    });
  };
  if (Array.isArray(source)) {
    for (const entry of source) push(entry);
  } else if (source && typeof source === "object") {
    for (const entry of source.sealed_commands || []) push(entry);
    for (const entry of source.results || []) push(entry);
  }
  const byCommand = new Map();
  for (const row of rows) {
    const existing = byCommand.get(row.command);
    if (!existing || (!existing.pass && row.pass)) byCommand.set(row.command, row);
  }
  return byCommand;
}

/**
 * Normalize one declared adversarial check. `risk` and `hypothesis` are the same
 * field under two names; `command` marks an execution rather than pure analysis.
 */
export function normalizeAdversarialCheck(entry = {}) {
  const check = entry && typeof entry === "object" ? entry : {};
  const hypothesis = String(check.hypothesis ?? check.risk ?? "").trim();
  const command = normalizeCommandKey(check.argv?.length ? check.argv : check.command);
  return {
    hypothesis,
    risk: hypothesis,
    command: command || null,
    reason: String(check.reason ?? "").trim(),
    result: String(check.result ?? "").trim().toUpperCase(),
    evidence: String(check.evidence ?? "").trim(),
    executed: Boolean(command),
  };
}

/**
 * Classify the commands a reviewer declared against sealed evidence.
 *
 * @returns {{adversarial_command_count: number, duplicate_command_count: number,
 *   duplicates: object[], errors: string[], checks: object[]}}
 */
export function classifyReviewerCommands(handoff = {}, sealedSource = null) {
  const sealed = sealedCommandIndex(sealedSource);
  const raw = Array.isArray(handoff?.adversarial_checks)
    ? handoff.adversarial_checks
    : [];
  const checks = raw.map(normalizeAdversarialCheck);
  const duplicates = [];
  const errors = [];
  let executed = 0;

  for (const [index, check] of checks.entries()) {
    if (!check.executed) continue;
    executed += 1;
    if (!check.hypothesis) {
      errors.push(
        `adversarial_checks[${index}] executed \`${check.command}\` without a hypothesis; state the specific risk the sealed evidence does not answer`,
      );
    }
    if (!check.reason) {
      errors.push(
        `adversarial_checks[${index}] executed \`${check.command}\` without a reason; explain why sealed verification cannot answer it`,
      );
    }
    const sealedMatch = sealed.get(check.command);
    if (sealedMatch?.pass) {
      duplicates.push({
        index,
        command: check.command,
        sealed_step: sealedMatch.id,
        result: check.result || null,
        informative: check.result === "FAIL" || check.result === "CANNOT_VERIFY",
      });
      if (check.result !== "FAIL" && check.result !== "CANNOT_VERIFY") {
        errors.push(
          `adversarial_checks[${index}] re-ran sealed passing command \`${check.command}\`${sealedMatch.id ? ` (sealed step ${sealedMatch.id})` : ""} and reported ${check.result || "no result"}; consume sealed verification instead of replaying it`,
        );
      }
    }
  }

  return {
    version: REVIEWER_COMMAND_POLICY_VERSION,
    adversarial_command_count: executed,
    duplicate_command_count: duplicates.length,
    duplicates,
    errors,
    checks,
    sealed_command_count: sealed.size,
  };
}

// A review loop costs an implementer and a reviewer call. Keep the ceiling
// small and deterministic so one hard unit cannot consume the whole run.
export const DEFAULT_MAX_FIX_LOOP_ATTEMPTS = 3;

// Keep automatic verification repair bounded to one implementer/review pass.
export const DEFAULT_MAX_VERIFICATION_REPAIR_ATTEMPTS = 1;

export function isLikelyProductionPath(file) {
  const f = String(file || "").replace(/\\/g, "/");
  if (!f || f.startsWith(".opencode/")) return false;
  if (/(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(f)) return false;
  if (/\.(test|spec)\.[a-z0-9]+$/i.test(f)) return false;
  if (/(^|\/)docs?(\/|$)/i.test(f)) return false;
  if (/\.(md|txt|rst)$/i.test(f)) return false;
  return true;
}

export function normalizeFinding(finding = {}) {
  const severity = String(finding.severity || "MEDIUM").toUpperCase();
  return {
    id: finding.id || `F-${Math.random().toString(36).slice(2, 8)}`,
    severity,
    title: finding.title || finding.summary || "finding",
    evidence: finding.evidence || finding.detail || "",
    commit: finding.commit || finding.reviewed_commit || null,
    resolved: finding.resolved === true,
    blocking:
      finding.blocking === true
        ? true
        : finding.blocking === false
          ? false
          : severity === "HIGH" || severity === "CRITICAL",
  };
}

/** Severity describes impact; blocking describes whether the workflow must stop. */
export function isBlockingFinding(finding = {}) {
  const n = normalizeFinding(finding);
  return !n.resolved && n.blocking === true;
}

export function unresolvedHighFindings(findings = []) {
  return findings.map(normalizeFinding).filter(isBlockingFinding);
}

export function canSelfApprove({ author_agent, reviewer_agent } = {}) {
  if (!author_agent || !reviewer_agent) return false;
  return author_agent === reviewer_agent;
}

function hasAcceptanceEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return false;
  return evidence.every(
    (e) =>
      e &&
      typeof e.file === "string" &&
      e.file.trim().length > 0 &&
      typeof e.reason === "string" &&
      e.reason.trim().length > 0,
  );
}

function normPath(p) {
  return String(p || "")
    .trim()
    .replace(/\\/g, "/");
}

/**
 * Expected acceptance list for this review (task or aggregated final).
 */
export function expectedAcceptanceCriteria(state = {}, opts = {}) {
  if (Array.isArray(opts.acceptance_criteria) && opts.acceptance_criteria.length) {
    return opts.acceptance_criteria.map(String);
  }
  if (
    opts.review_scope === "final" &&
    Array.isArray(state.task_history) &&
    state.task_history.length
  ) {
    return state.task_history.flatMap((t) =>
      Array.isArray(t.acceptance_criteria) ? t.acceptance_criteria.map(String) : [],
    );
  }
  if (Array.isArray(state.acceptance_criteria) && state.acceptance_criteria.length) {
    return state.acceptance_criteria.map(String);
  }
  return [];
}

/**
 * Gate-level check: an APPROVED string alone is never sufficient.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function isApprovalAdmissible(handoff, state = {}, opts = {}) {
  const errors = [];
  if (!handoff || typeof handoff !== "object") {
    return { ok: false, errors: ["APPROVED requires a reviewer handoff"] };
  }
  if (handoff.verdict !== "APPROVED") {
    return {
      ok: false,
      errors: [`approval admissibility requires APPROVED, got ${handoff.verdict}`],
    };
  }

  const acceptance = Array.isArray(handoff.acceptance) ? handoff.acceptance : [];
  const expected = expectedAcceptanceCriteria(state, {
    review_scope: handoff.review_scope || opts.review_scope,
    acceptance_criteria: opts.acceptance_criteria,
  });
  const minAcceptance = expected.length > 0 ? expected.length : 1;
  if (acceptance.length < minAcceptance) {
    errors.push(
      `APPROVED requires at least ${minAcceptance} evidence-backed acceptance entr${minAcceptance === 1 ? "y" : "ies"} (got ${acceptance.length})`,
    );
  }

  // Exact-match: each persisted criterion must have a PASS entry (by AC-N id or text).
  if (expected.length > 0) {
    for (let i = 0; i < expected.length; i++) {
      const want = expected[i];
      const id = `AC-${i + 1}`;
      const match = acceptance.find(
        (ac) =>
          ac &&
          (String(ac.id) === id ||
            String(ac.id).toLowerCase() === want.toLowerCase() ||
            String(ac.criterion || "").toLowerCase() === want.toLowerCase() ||
            (Array.isArray(ac.evidence) &&
              ac.evidence.some((e) =>
                String(e.reason || "")
                  .toLowerCase()
                  .includes(want.toLowerCase().slice(0, 40)),
              ))),
      );
      if (!match) {
        errors.push(
          `APPROVED missing acceptance coverage for criterion ${id} (${want})`,
        );
      } else if (match.status !== "PASS") {
        errors.push(
          `acceptance for ${id} must be PASS for APPROVED (got ${match.status})`,
        );
      } else if (!hasAcceptanceEvidence(match.evidence)) {
        errors.push(`acceptance for ${id} requires non-empty file/reason evidence`);
      }
    }
  } else {
    for (let i = 0; i < acceptance.length; i++) {
      const ac = acceptance[i] || {};
      if (ac.status !== "PASS") {
        errors.push(
          `acceptance[${i}] (${ac.id || "unknown"}) must be PASS for APPROVED (got ${ac.status})`,
        );
      }
      if (!hasAcceptanceEvidence(ac.evidence)) {
        errors.push(
          `acceptance[${i}] (${ac.id || "unknown"}) requires non-empty file/reason evidence`,
        );
      }
    }
  }

  const files = Array.isArray(handoff.files_reviewed)
    ? handoff.files_reviewed.map(normPath).filter(Boolean)
    : [];
  if (files.length === 0) {
    errors.push("APPROVED requires non-empty files_reviewed");
  }

  const reviewedSet = new Set(files);
  if (handoff.files_skipped !== undefined && !Array.isArray(handoff.files_skipped)) {
    errors.push("files_skipped must be an array of entries with file and reason");
  }
  const skipped = Array.isArray(handoff.files_skipped) ? handoff.files_skipped : [];
  const skippedSet = new Set();
  for (const [index, entry] of skipped.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`files_skipped[${index}] requires an object with file and non-empty reason`);
      continue;
    }
    const file = typeof entry.file === "string" ? normPath(entry.file) : "";
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (!file || !reason) {
      errors.push(
        `files_skipped[${index}] requires a non-empty file and reason`,
      );
      continue;
    }
    skippedSet.add(file);
  }

  const pkg = opts.review_package || state.review_package || null;
  const mustReview = (
    opts.required_files ||
    pkg?.production_files ||
    (pkg?.changed_files || []).filter(isLikelyProductionPath) ||
    []
  )
    .map(normPath)
    .filter(Boolean);

  for (const f of mustReview) {
    if (!reviewedSet.has(f) && !skippedSet.has(f)) {
      errors.push(
        `APPROVED requires files_reviewed (or explicit files_skipped+reason) to cover changed production file: ${f}`,
      );
    }
  }

  const checks = Array.isArray(handoff.checks) ? handoff.checks : [];
  for (const cat of MANDATORY_CHECK_CATEGORIES) {
    const c = checks.find((x) => x && x.category === cat);
    if (!c) {
      errors.push(`APPROVED requires check category "${cat}" with evidence`);
      continue;
    }
    if (c.status !== "PASS") {
      errors.push(`check "${cat}" must be PASS for APPROVED (got ${c.status})`);
    }
    if (typeof c.evidence !== "string" || !c.evidence.trim()) {
      errors.push(`check "${cat}" requires non-empty evidence`);
    }
  }

  const findings = Array.isArray(handoff.findings) ? handoff.findings : [];
  const blocking = findings.filter(isBlockingFinding);
  if (blocking.length > 0) {
    errors.push(
      `APPROVED blocked by unresolved findings: ${blocking.map((f) => f.id || f.title || "finding").join(", ")}`,
    );
  }

  // PR6.A: declared reviewer executions must be hypothesis-driven probes, not
  // reconfirmation of sealed deterministic checks.
  const commandPolicy = classifyReviewerCommands(
    handoff,
    opts.sealed_verification ||
      pkg ||
      state.provider_verification ||
      state.final_verification ||
      null,
  );
  errors.push(...commandPolicy.errors);

  return { ok: errors.length === 0, errors, command_policy: commandPolicy };
}

export function fixLoopDecision({
  findings = [],
  attempt = 0,
  max_attempts = DEFAULT_MAX_FIX_LOOP_ATTEMPTS,
} = {}) {
  const openHigh = unresolvedHighFindings(findings);
  const currentAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
  const maxAttempts = Math.max(
    0,
    Math.floor(Number(max_attempts) || DEFAULT_MAX_FIX_LOOP_ATTEMPTS),
  );
  if (currentAttempt >= maxAttempts) {
    return {
      action: "block",
      reason:
        openHigh.length > 0
          ? "fix loop exhausted with unresolved blocking findings"
          : "fix loop exhausted",
      open_high: openHigh,
    };
  }
  return {
    action: "redispatch_implementer",
    attempt: currentAttempt + 1,
    open_high: openHigh,
  };
}
