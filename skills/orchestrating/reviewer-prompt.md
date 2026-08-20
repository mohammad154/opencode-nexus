# Reviewer dispatch prompt (V5)

Use for **every** task after VERIFYING. There is no dual/unified/skip matrix.

```text
Profile: default (fixed V5 pipeline)
Task: [task id / title]
Acceptance: [criteria]
Pre-impact + post-impact paths: [paths]
Implementer commit: [sha]
```

Checklist:

1. Spec / acceptance criteria met with file:line evidence; scope In/Out respected.
2. Correctness.
3. Code quality.
4. Impact/callers from post-impact report still valid; flag scope creep.
5. Tests sufficient.

Write `.opencode/handoffs/[id]-reviewer.json` (schema_version 1.1):

```json
{
  "schema_version": "1.1",
  "run_id": "<run-id>",
  "unit_or_task": "<task-id>",
  "agent": "reviewer",
  "base_commit": "<pre-impl head>",
  "created_at": "<iso>",
  "verdict": "APPROVED",
  "reviewed_commit": "<implementer commit>",
  "acceptance": [],
  "findings": [],
  "impact": { "pass": true, "risk": "LOW" },
  "notes": ""
}
```

Verdicts: `APPROVED` | `REQUEST_CHANGES` | `ISOLATION_VIOLATION` | `BLOCKED`.

Gate:

```bash
jq -e '.verdict=="APPROVED"' .opencode/handoffs/<id>-reviewer.json
```

On `REQUEST_CHANGES`, the orchestrator must automatically: fresh pre-impact → implementer → post-impact → verify → reviewer again. Do not wait for the user to ask for fixes.
