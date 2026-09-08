# Nexus V5 workflow

Nexus is a **fixed** three-agent execution workflow for OpenCode. The orchestrator coordinates; the implementer codes; the reviewer stays read-only; **scripts own measurement and gates**. A conditional `plan-advisor` may challenge standard/deep plans, but it is planning-only and never enters the execution loop.

## Three invariants

1. Every request starts with brainstorming and a plan.
2. Every implementer call requires fresh impact analysis.
3. Every implementation must be approved by an independent reviewer.

## Lifecycle

```text
request → brainstorm → (optional plan-advisor) → plan → plan-check → (per execution unit) pre-impact → implement → post-impact+verify → review → final verify → finish
```

Durable state: `.opencode/runs/<run-id>/state.json`

States: `CREATED` → `BRAINSTORMING` ↔ `WAITING_FOR_USER` → `PLANNED` → `TASK_IMPACT_READY` → `IMPLEMENTING` → `VERIFYING` → `REVIEWING` → (`TASK_IMPACT_READY` on REQUEST_CHANGES / next unit) → `FINAL_REVIEWING` → `FINAL_VERIFYING` → `COMPLETED`

## Impact Engine

```bash
nexus impact --json
nexus run transition --to TASK_IMPACT_READY
```

Pre-impact before every implementer (including fix loops). Post-impact during VERIFYING.

## Review

Always: `nexus review-package --scope task` then dispatch `reviewer` after VERIFYING.

After the last task APPROVED: `nexus review-package --scope final` then dispatch `reviewer` again (`review_scope: final`) before `FINAL_VERIFYING`. Final packages use immutable `run_base_commit..HEAD` (whole branch), not the last task’s pre-head.

For a genuinely single-unit run, the task review may be reused for
`FINAL_VERIFYING` only when the caller opts in and Nexus can bind the same
reviewed commit to the current `HEAD`, recompute the review-package digest, and
confirm that no code outside `.opencode/` changed after review. Any failed
binding, changed byte, or additional unit falls back to the whole-branch final
review path.

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
orchestrator  (execution controller)
implementer   (execution unit implementation)
reviewer      (unit review + multi-unit final integration review)
plan-advisor  (conditional planning-only challenge; not in the execution loop)
```

## Inspect / next step

```bash
nexus next                 # deterministic next orchestrator action
nexus next --json
nexus run inspect --run-id <id>
nexus estimate --tasks 3
nexus run transition --to PLANNED --plan-check
```

`task-*` identifiers remain accepted for V5 compatibility, but new plans should
use **Execution Unit** headings. Each unit should be cohesive, independently
verifiable, reviewable, and safe. Add an `## Execution Unit Justification`
section explaining why the plan has neither fewer nor more units.

Planning depth is `compact`, `standard`, or `deep`. Compact planning skips the
advisor; standard planning uses one advisor call; deep planning uses one call
and permits a second only for an explicit `CRITICAL_DISAGREEMENT`.

`nexus next` (and the plugin’s injected **Nexus Next Action** block) tells the orchestrator what to do now — including `REQUIRED_DISPATCH: implementer|reviewer` when a Task dispatch is mandatory.

The standalone `nexus plan-check` command is diagnostic. To authorize the
`PLANNED` transition, use `nexus run transition --to PLANNED --plan-check` so
the passing report is attached to durable run state.

Before `PLANNED`, every actionable `plan-check` warning must have a matching
`MERGED` or `KEEP_SEPARATE` disposition with a reason. This keeps heuristic
decomposition findings advisory while making the final granularity decision
explicit and auditable.
