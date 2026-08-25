# Reviewer dispatch prompt (V5)

Use after VERIFYING (**task** scope) and again after the last task is approved (**final** / whole-branch scope). One reviewer role; two scopes.

## Before every dispatch

```bash
nexus review-package --scope task|final --json
```

Pass the returned package meta into the reviewer context and into later transitions as `review_package`. The package is the authority for BASE/HEAD, diff, acceptance, impact, and verification — treat implementer notes inside it as **unverified claims**.

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

Read **in order**:

1. The review package (task brief, acceptance, BASE..HEAD diff, impact, verification)
2. Changed production files and relevant callers/tests called out by the package
3. For `review_scope: final` — the whole branch / cross-task integration surface, not only the latest task diff

For every acceptance criterion:

- Determine `PASS` / `FAIL` / `CANNOT_VERIFY`
- Provide file:line evidence
- Attempt to identify at least one realistic failure mode

For changed behavior, inspect edge cases, error paths, affected contracts/callers, and whether tests exercise production behavior (not duplicated test helpers).

Mandatory check categories (each needs status + evidence): `correctness`, `test_quality`, `impact`.

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
      "id": "AC-1",
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
    { "risk": "<realistic failure mode>", "result": "<PASS|FAIL|CANNOT_VERIFY>", "evidence": "..." }
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

Findings: set `blocking: true|false` explicitly. Severity describes impact; `blocking` controls the workflow.

### Scope rules

- `task` — after VERIFYING for the current unit. Last-task APPROVED → orchestrator transitions to `FINAL_REVIEWING` (not `FINAL_VERIFYING`).
- `final` — whole-branch / cross-task review while in `FINAL_REVIEWING`. APPROVED → `FINAL_VERIFYING`.

On `REQUEST_CHANGES`, the orchestrator must automatically: fresh pre-impact → implementer → post-impact → verify → reviewer again. Do not wait for the user to ask for fixes.
