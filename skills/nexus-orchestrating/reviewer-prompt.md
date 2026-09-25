# Reviewer dispatch prompt (V5)

Use only after `VERIFYING/PASSED` (**task** scope) and again after the last task is approved (**final** / whole-branch scope). One reviewer role; two scopes.

## Before every dispatch

```bash
nexus review-package --scope task|final --json
```

Pass the returned package meta into the reviewer context and into later transitions as `review_package`. The package is the authority for BASE/HEAD, acceptance, impact, and sealed verification — treat implementer notes inside it as **unverified claims**.

The package is a deterministic **selection**, not a dump:

- **task scope** — identity, the current execution unit (from the normalized plan), acceptance criteria, changed/production files, diff stat, impact callers and related tests, the sealed verification summary, focused hunks for changed production files and their tests, untrusted implementer notes.
- **final scope** — run objective, `Previous task review evidence` (task approval summaries with `review_evidence_bound` and `files_changed_after_review`), cross-unit/shared files, public/shared contract changes, integration hotspots, per-unit change ranges, diff stat/index, focused integration hunks.

Anything not quoted is named with the exact read-only command that retrieves it. The reviewer has read-only `git diff` / `git show` / `git log` / `rg` and is expected to use them.

```text
Profile: default (fixed V5 pipeline)
Task: [task id / title]
Acceptance criteria: [list each criterion — do not imply they already pass]
Review package path: [.opencode/reviews/…-review-package.md]
Pre-impact + post-impact paths: [paths]
Implementer commit: [sha]
Review scope: task | final
```

You are independently reviewing this implementation.

There is **no expected verdict**. The controller does not want APPROVED or REQUEST_CHANGES in advance.

Your objective is to determine whether the patch is wrong, incomplete, fragile, unnecessarily broad, or insufficiently tested.

Treat all implementer claims as **unverified**. Do not infer correctness from passing tests alone. Do not infer a desired verdict from controller wording.

Sealed deterministic verification is authoritative: **consume it, do not replay it.** Do not re-run an already-sealed test/lint/typecheck/build command to reconfirm that it passes. Run a command only for a specific hypothesis the sealed evidence does not answer (a concrete edge case, malformed input, integration path, or test-quality suspicion), and record it in `adversarial_checks` with `hypothesis`, `command`, and `reason`. Nexus rejects an `APPROVED` handoff whose declared command lacks a hypothesis/reason, or which re-runs a sealed passing command and reports `PASS`.

Read **in order**:

1. The review package (unit brief, acceptance, changed files, impact, sealed verification, focused hunks; for final scope, also `Previous task review evidence` and the integration sections)
2. Changed production files and relevant callers/tests called out by the package — read them directly with `git diff`/`rg` when the quoted hunks are not enough
3. For `review_scope: final` — the whole branch / cross-task integration surface and changes since the task approvals, not only the latest task diff

For task scope, assess every criterion owned by the current unit:

- Determine `PASS` / `FAIL` / `CANNOT_VERIFY`
- Provide file:line evidence
- Attempt to identify at least one realistic failure mode

For final scope, reuse a prior result only when `review_evidence_bound: true`,
`files_changed_after_review` is available, and none of the criterion's owning
files appears in that list. Confirm the recorded unit, reviewed commit, and
package digest bindings. Use bound approvals for unchanged unit-specific
criteria, then focus effort on cross-unit integration and changes since those
approvals. Reopen any criterion whose owning files changed, whose evidence is
missing, unbound, stale, or lacks a post-review file list, or whose integration
reveals a defect. Inspect the whole-branch diff and complete the mandatory final
review; task evidence never replaces that review.

For changed behavior, inspect edge cases, error paths, affected contracts/callers, and whether tests exercise production behavior (not duplicated test helpers).

Mandatory check categories (each needs status + evidence): `correctness`, `test_quality`, `impact`.
Allowed check categories are `correctness`, `test_quality`, `impact`, `scope`, `spec_fidelity`, and optional `verification`. Do not invent another category; `verification` is an additional review check and does not replace the three mandatory categories.

Write `.opencode/handoffs/[id]-reviewer.json` (schema_version **1.2**):

```json
{
  "schema_version": "1.2",
  "run_id": "<run-id>",
  "unit_or_task": "<task-id>",
  "agent": "reviewer",
  "base_commit": "<pre-impl head or branch base>",
  "created_at": "<iso>",
  "review_scope": "<task|final>",
  "reviewed_commit": "<implementer commit or branch HEAD>",
  "files_reviewed": ["<changed production file>", "<relevant test>"],
  "acceptance": [
    {
      "id": "<the id the package published, e.g. unit-1/AC1; else AC-1>",
      "criterion": "<the criterion text you evaluated>",
      "status": "<PASS|FAIL|CANNOT_VERIFY>",
      "evidence": [
        { "file": "<path>", "line": 0, "reason": "<why this status>" }
      ]
    }
  ],
  "checks": [
    { "category": "correctness", "status": "<PASS|FAIL|CANNOT_VERIFY>", "evidence": "..." },
    { "category": "test_quality", "status": "<PASS|FAIL|CANNOT_VERIFY>", "evidence": "..." },
    { "category": "impact", "status": "<PASS|FAIL|CANNOT_VERIFY>", "evidence": "..." }
  ],
  "adversarial_checks": [
    { "risk": "<realistic failure mode analyzed, no command needed>", "result": "<PASS|FAIL|CANNOT_VERIFY>", "evidence": "..." },
    {
      "hypothesis": "<specific risk sealed verification does not answer>",
      "command": "<focused command you ran>",
      "reason": "<why sealed verification cannot answer it>",
      "result": "<PASS|FAIL|CANNOT_VERIFY>",
      "evidence": "..."
    }
  ],
  "findings": [],
  "verdict": "<decision-after-review>",
  "impact": { "pass": null, "risk": "UNKNOWN" },
  "notes": ""
}
```

Decide the verdict **only after** completing the review.

Verdicts: `APPROVED` | `REQUEST_CHANGES` | `ISOLATION_VIOLATION` | `BLOCKED`.

Nexus admits `APPROVED` only when every acceptance is PASS with evidence, mandatory checks PASS with evidence, `files_reviewed` is non-empty, and there are no blocking findings. An empty approval is gate-invalid.

Report one acceptance entry per criterion, using the stable id the package shows
next to each criterion (`AC-1 (id: unit-1/AC1)`). Those ids are how the run's
traceability ledger proves the criterion was demonstrated; a positional `AC-n`
alone still works but is recorded as a weaker, position-only match. Include the
`criterion` text you evaluated so the evidence stays readable after the fact.

Findings: set `blocking: true|false` explicitly. Severity describes impact; `blocking` controls the workflow.

### Scope rules

- `task` — after `VERIFYING/PASSED` for the current unit. Last-task APPROVED → orchestrator transitions to `FINAL_REVIEWING` (not `FINAL_VERIFYING`).
- `final` — whole-branch / cross-task review while in `FINAL_REVIEWING`. APPROVED → `FINAL_VERIFYING`.

Every execution unit still requires its task reviewer, and every multi-unit run
still requires this final reviewer. Bound task evidence can avoid repeating an
unchanged criterion audit; it cannot skip either reviewer gate.

On `REQUEST_CHANGES`, the orchestrator must automatically: fresh pre-impact → implementer → post-impact → verify → reviewer again. Do not wait for the user to ask for fixes.
