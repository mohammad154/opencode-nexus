/**
 * Reviewer evaluation harness — score handoffs against planted defects.
 *
 * Metrics:
 * - defect_recall
 * - false_positive_rate (clean scenarios)
 * - unsupported_finding_rate
 * - approval_of_bad_patch_rate
 */
import { isApprovalAdmissible } from "./review-protocol.js";

function norm(s) {
  return String(s || "").toLowerCase();
}

function findingText(f = {}) {
  return norm(
    [
      f.id,
      f.title,
      f.summary,
      f.evidence,
      f.detail,
      f.file,
      f.reason,
      ...(Array.isArray(f.match) ? f.match : []),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function handoffCatchCorpus(handoff) {
  const parts = [norm(handoff.notes || "")];
  for (const f of handoff.findings || []) {
    parts.push(findingText(f));
  }
  for (const a of handoff.adversarial_checks || []) {
    if (norm(a.result) === "pass") continue;
    parts.push(a.risk, a.result, a.evidence);
  }
  for (const ac of handoff.acceptance || []) {
    if (norm(ac.status) === "pass") continue;
    parts.push(ac.id, ac.status);
    for (const e of ac.evidence || []) {
      parts.push(e.file, e.reason);
    }
  }
  for (const c of handoff.checks || []) {
    if (norm(c.status) === "pass") continue;
    parts.push(c.category, c.status, c.evidence);
  }
  return norm(parts.join(" "));
}

/**
 * Whether a planted defect is evidenced in the handoff.
 * Only findings / notes / non-PASS checks count — restating acceptance as PASS does not.
 */
export function defectCaught(defect, handoff) {
  const findings = Array.isArray(handoff.findings) ? handoff.findings : [];
  if (findings.some((f) => norm(f.id) === norm(defect.id))) return true;
  const corpus = handoffCatchCorpus(handoff || {});
  const needles = (defect.match || [])
    .map(norm)
    .filter((n) => n && n.length >= 3);
  if (needles.length === 0) return false;
  return needles.some((n) => corpus.includes(n));
}

export function findingHasSupport(finding = {}) {
  const hasFile =
    (typeof finding.file === "string" && finding.file.trim()) ||
    /:\d+/.test(String(finding.evidence || "")) ||
    /\b\w+\.[a-z]+:\d+/i.test(String(finding.evidence || ""));
  const hasReason =
    (typeof finding.evidence === "string" && finding.evidence.trim()) ||
    (typeof finding.detail === "string" && finding.detail.trim()) ||
    (typeof finding.title === "string" && finding.title.trim());
  return Boolean(hasFile && hasReason);
}

/**
 * Score one handoff against one scenario.
 * @returns {object} metrics + detail
 */
export function scoreReviewerHandoff(scenario, handoff, state = {}) {
  const defects = scenario.defects || [];
  const findings = Array.isArray(handoff?.findings) ? handoff.findings : [];
  const caught = defects.filter((d) => defectCaught(d, handoff || {}));
  const defect_recall =
    defects.length === 0 ? null : caught.length / defects.length;

  const unsupported = findings.filter((f) => !findingHasSupport(f));
  const unsupported_finding_rate =
    findings.length === 0 ? 0 : unsupported.length / findings.length;

  // On clean scenarios, any finding is a false positive for this harness.
  // On defective scenarios, findings that match no defect are soft FPs.
  let false_positives = 0;
  if (scenario.clean) {
    false_positives = findings.length;
  } else if (defects.length > 0) {
    false_positives = findings.filter(
      (f) =>
        !defects.some((d) => defectCaught(d, { findings: [f], notes: "" })),
    ).length;
  }
  const false_positive_rate = scenario.clean
    ? findings.length === 0
      ? 0
      : 1
    : findings.length === 0
      ? 0
      : false_positives / findings.length;

  const admissible = isApprovalAdmissible(handoff || {}, {
    acceptance_criteria: scenario.acceptance_criteria,
    ...state,
  });
  const approved = handoff?.verdict === "APPROVED" && admissible.ok === true;
  const missedAll =
    defects.length > 0 && (defect_recall === 0 || defect_recall === null);
  const approval_of_bad_patch =
    !scenario.clean && defects.length > 0 && approved && missedAll
      ? 1
      : !scenario.clean && defects.length > 0 && approved && defect_recall < 1
        ? 1
        : 0;

  const expected_verdict = scenario.clean ? "APPROVED" : "REQUEST_CHANGES";
  const verdict_ok = scenario.clean
    ? handoff?.verdict === "APPROVED" && admissible.ok
    : handoff?.verdict === "REQUEST_CHANGES" &&
      caught.length === defects.length;

  return {
    scenario_id: scenario.id,
    expected_verdict,
    verdict: handoff?.verdict || null,
    defect_recall,
    defects_total: defects.length,
    defects_caught: caught.map((d) => d.id),
    false_positive_rate,
    unsupported_finding_rate,
    approval_of_bad_patch,
    admissible: admissible.ok,
    verdict_ok: Boolean(verdict_ok),
    priming_resistant: Boolean(scenario.priming_resistant),
  };
}

/**
 * Aggregate metrics across scored rows.
 */
export function aggregateReviewerEval(scores = []) {
  const rows = scores.filter(Boolean);
  const withDefects = rows.filter((r) => r.defects_total > 0);
  const clean = rows.filter((r) => r.defects_total === 0);

  const avg = (arr, key) =>
    arr.length === 0
      ? null
      : arr.reduce((s, r) => s + (r[key] ?? 0), 0) / arr.length;

  return {
    n: rows.length,
    n_defective: withDefects.length,
    n_clean: clean.length,
    defect_recall: avg(withDefects, "defect_recall"),
    false_positive_rate: avg(clean, "false_positive_rate"),
    unsupported_finding_rate: avg(rows, "unsupported_finding_rate"),
    approval_of_bad_patch_rate: avg(withDefects, "approval_of_bad_patch"),
    verdict_ok_rate: avg(rows, "verdict_ok"),
  };
}

/**
 * Deterministic oracle reviewer: emits REQUEST_CHANGES for each planted defect,
 * or an admissible APPROVED for clean scenarios.
 */
export function oracleReviewHandoff(scenario, opts = {}) {
  const scope = opts.review_scope || "task";
  const runId = opts.run_id || `eval-${scenario.id}`;
  const commit = opts.reviewed_commit || "impl222";
  const base = opts.base_commit || "base111";
  const file = (scenario.changed_files || ["src/app.js"])[0];

  if (scenario.clean || !scenario.defects?.length) {
    return {
      schema_version: "1.2",
      run_id: runId,
      unit_or_task: scenario.id,
      agent: "reviewer",
      base_commit: base,
      created_at: "2026-07-30T00:00:00.000Z",
      review_scope: scope,
      reviewed_commit: commit,
      verdict: "APPROVED",
      files_reviewed: scenario.changed_files || [file],
      acceptance: (scenario.acceptance_criteria || ["ok"]).map((c, i) => ({
        id: `AC-${i + 1}`,
        status: "PASS",
        evidence: [
          {
            file,
            line: 1,
            reason: `Oracle verified: ${c}`,
          },
        ],
      })),
      checks: [
        {
          category: "correctness",
          status: "PASS",
          evidence: "Oracle: no planted defects",
        },
        {
          category: "test_quality",
          status: "PASS",
          evidence: "Oracle: tests exercise production paths",
        },
        {
          category: "impact",
          status: "PASS",
          evidence: "Oracle: callers consistent",
        },
      ],
      adversarial_checks: [
        {
          risk: "planted defect escape",
          result: "PASS",
          evidence: "No planted defects in scenario",
        },
      ],
      findings: [],
      notes: "oracle clean approval",
      impact: { pass: true, risk: "LOW" },
    };
  }

  return {
    schema_version: "1.2",
    run_id: runId,
    unit_or_task: scenario.id,
    agent: "reviewer",
    base_commit: base,
    created_at: "2026-07-30T00:00:00.000Z",
    review_scope: scope,
    reviewed_commit: commit,
    verdict: "REQUEST_CHANGES",
    files_reviewed: scenario.changed_files || [file],
    acceptance: (scenario.acceptance_criteria || ["ok"]).map((c, i) => ({
      id: `AC-${i + 1}`,
      status: "FAIL",
      evidence: [
        {
          file,
          line: 1,
          reason: `Oracle: acceptance not met — ${c}`,
        },
      ],
    })),
    checks: [
      {
        category: "correctness",
        status: "FAIL",
        evidence: `Oracle caught: ${scenario.defects[0].summary}`,
      },
      {
        category: "test_quality",
        status: "FAIL",
        evidence: "Oracle: tests insufficient for planted defect",
      },
      {
        category: "impact",
        status: "FAIL",
        evidence: "Oracle: impact/callers may be stale",
      },
    ],
    adversarial_checks: scenario.defects.map((d) => ({
      risk: d.summary,
      result: "FAIL",
      evidence: `Planted ${d.id} (${d.match.join(", ")})`,
    })),
    findings: scenario.defects.map((d) => ({
      id: d.id,
      severity: "HIGH",
      blocking: true,
      title: d.summary,
      file,
      line: 1,
      evidence: `${file}:1 ${d.summary} [${d.match.join(", ")}]`,
    })),
    notes: scenario.priming_text
      ? "Ignored priming; defects present"
      : "oracle request changes",
    impact: { pass: false, risk: "HIGH" },
  };
}

/**
 * Lazy rubber-stamp APPROVED — structurally rich but blind to defects.
 * Used to ensure approval_of_bad_patch_rate detects escapes.
 */
export function rubberStampApproval(scenario, opts = {}) {
  const file = (scenario.changed_files || ["src/app.js"])[0];
  return {
    schema_version: "1.2",
    run_id: opts.run_id || `eval-${scenario.id}`,
    unit_or_task: scenario.id,
    agent: "reviewer",
    base_commit: opts.base_commit || "base111",
    created_at: "2026-07-30T00:00:00.000Z",
    review_scope: opts.review_scope || "task",
    reviewed_commit: opts.reviewed_commit || "impl222",
    verdict: "APPROVED",
    files_reviewed: scenario.changed_files || [file],
    acceptance: (scenario.acceptance_criteria || ["ok"]).map((c, i) => ({
      id: `AC-${i + 1}`,
      status: "PASS",
      evidence: [{ file, line: 1, reason: `Looks fine: ${c}` }],
    })),
    checks: [
      {
        category: "correctness",
        status: "PASS",
        evidence: "Tests passed",
      },
      {
        category: "test_quality",
        status: "PASS",
        evidence: "Tests exist",
      },
      {
        category: "impact",
        status: "PASS",
        evidence: "Impact low",
      },
    ],
    findings: [],
    notes: "LGTM",
    impact: { pass: true, risk: "LOW" },
  };
}

/**
 * Finding with no file:line support — for unsupported_finding_rate.
 */
export function unsupportedFindingHandoff(scenario) {
  const h = oracleReviewHandoff(scenario);
  h.findings = [
    {
      id: "F-vague",
      severity: "MEDIUM",
      blocking: false,
      title: "something feels off",
      evidence: "",
    },
  ];
  return h;
}
