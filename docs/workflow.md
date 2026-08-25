# Nexus V5 workflow

Nexus is a **fixed** three-agent development workflow for OpenCode. The orchestrator coordinates; the implementer codes; the reviewer stays read-only; **scripts own measurement and gates**.

## Three invariants

1. Every request starts with brainstorming and a plan.
2. Every implementer call requires fresh impact analysis.
3. Every implementation must be approved by an independent reviewer.

## Lifecycle

```text
request → brainstorm → plan → (per task) pre-impact → implement → post-impact+verify → review → final verify → finish
```

Durable state: `.opencode/runs/<run-id>/state.json`

States: `CREATED` → `BRAINSTORMING` ↔ `WAITING_FOR_USER` → `PLANNED` → `TASK_IMPACT_READY` → `IMPLEMENTING` → `VERIFYING` → `REVIEWING` → (`TASK_IMPACT_READY` on REQUEST_CHANGES / next task) → `FINAL_REVIEWING` → `FINAL_VERIFYING` → `COMPLETED`

## Impact Engine

```bash
nexus impact --json
nexus run transition --to TASK_IMPACT_READY
```

Pre-impact before every implementer (including fix loops). Post-impact during VERIFYING.

## Review

Always: `nexus review-package --scope task` then dispatch `reviewer` after VERIFYING.

After the last task APPROVED: `nexus review-package --scope final` then dispatch `reviewer` again (`review_scope: final`) before `FINAL_VERIFYING`. Final packages use immutable `run_base_commit..HEAD` (whole branch), not the last task’s pre-head.

Verdicts: `APPROVED` | `REQUEST_CHANGES`. Approvals require evidence (all persisted acceptance criteria, mandatory checks, production-file coverage in `files_reviewed` or explicit `files_skipped`, bound review-package digest); empty APPROVED is gate-invalid.

On `REQUEST_CHANGES`, the orchestrator automatically re-impacts and re-dispatches the implementer — the user does not need to ask for fixes.

Planted-defect reviewer evals (deterministic oracle + rubber-stamp suites):

```bash
nexus eval reviewer
nexus eval reviewer --json
```

Metrics: `defect_recall`, `false_positive_rate`, `unsupported_finding_rate`, `approval_of_bad_patch_rate`.

## Agent roster

```text
orchestrator
implementer
reviewer
```

## Inspect / next step

```bash
nexus next                 # deterministic next orchestrator action
nexus next --json
nexus run inspect --run-id <id>
nexus estimate --tasks 3
```

`nexus next` (and the plugin’s injected **Nexus Next Action** block) tells the orchestrator what to do now — including `REQUIRED_DISPATCH: implementer|reviewer` when a Task dispatch is mandatory.
