---
name: orchestrating
description: Use to execute a plan through the V4 state machine with Impact Engine evidence, TDD gates, isolated worktrees, and structured handoffs
compatibility: opencode
---

# Orchestrating (V4 — evidence-driven)

Agent claims are never evidence. Scripts measure; the state machine seals provider output; implementers code; reviewers are read-only.

## Prerequisites

- Confirm the workspace is a git repository.
- Load `using-feature-branches` and record `base_branch` in `.opencode/CONTEXT.md`.
- If `reconcile` was requested or drift is suspected, run `reconcile` before starting tasks.
- Read [`profiles.md`](profiles.md) — workflow profiles control branch/review/batch behavior.
- Graphify is **optional**. Do not block on `graphify-out/graph.json`. Use `nexus impact`.

## Workflow preferences gate

Before the execution loop (or when resuming if preferences are missing):

1. If `workflow_profile` is unset in `.opencode/CONTEXT.md`:
   - Classify via `nexus classify --apply` (see `profiles.md` / `config/workflow-profiles.json`) or ask the user.
   - Recommend `balanced` for normal multi-task features.
   - Allow explicit override: `fast` | `balanced` | `strict`.
2. If `branch_policy`, `execution_mode`, or `branch_cleanup_policy` are unset:
   - Derive defaults from profile (see table in `profiles.md`).
   - `strict` → recommend `isolated` + `checkpoint`.
   - `balanced`/`fast` → `branch_policy: per-feature`, `execution_mode: continuous` unless the user wants checkpoint.
3. Set `branch_cleanup_policy: always` by default; `cleanupPolicy: script` (run `scripts/nexus-branch-cleanup.sh` — never dispatch an LLM solely to delete branches).
4. Run the agent-call estimate and show the user:
   ```bash
   nexus estimate --tasks <N> --profile <profile>
   ```
5. Record answers in `.opencode/CONTEXT.md`. Do not re-ask on resume unless the user requests a change.

## Pre-execution preamble

1. Read `.opencode/memory/` (and Graphify lessons only if present) — retrieve top matching entries by path/subsystem.
2. Record `verification_baseline` on `base_branch` with `nexus` verification, not agent claims.
3. For `fast`/`balanced`: group pending tasks into execution units. Write `.opencode/tasks/execution-unit-<id>.json`.

## Delegation Gate (mandatory before production edits)

1. If `.opencode/` or `.opencode/runs/*/state.json` is missing → `nexus project-init` then `nexus run init --run-id <id>`.
2. If run state is before `IMPLEMENTING` → complete classify → plan → **pre-impact** (`IMPACT_READY`) transitions. **Do not create or edit production files.**
3. If run state is `IMPLEMENTING` → only dispatch implementer (or diagnostician first for bug-fixes) via Task tool. Orchestrator edits are limited to `.opencode/**`.
4. If Task dispatch fails → STOP and report (unless the stored classification is `direct_eligible` for documentation/formatting).
5. A pasted plan or "please implement" is not permission to self-code.

## Lifecycle (engine-enforced)

```text
CREATED → CLASSIFIED → PLANNED → IMPACT_READY (pre-impact)
  → IMPLEMENTING → VERIFYING (provider tests + post-impact)
  → REVIEWING → FINAL_VERIFYING → COMPLETED
```

```bash
nexus run init --run-id <id>
nexus classify --apply --json '{"changeClass":"<class>"}'
nexus run transition --to PLANNED --plan-skip
nexus impact --json --targets <planned files>
nexus run transition --to IMPACT_READY --json '{"planned_targets":["src/foo.js"]}'
nexus run transition --to IMPLEMENTING --branch <b> --acceptance 'c1|c2'
# after implementer handoff — VERIFYING re-runs verificationProvider; do not pass pass:true JSON
nexus run transition --to VERIFYING --json '{"implementer_handoff":{...}}'
nexus run transition --to REVIEWING
nexus run transition --to FINAL_VERIFYING --json '{"unified_handoff":{...}}'
# COMPLETED runs verificationProvider again; never pass final_verification.ok or skip_final_verification
nexus run transition --to COMPLETED
```

TDD is policy-driven: `bug-fix` and `behavioral-change` require red/green evidence. The implementer cannot omit `tdd_required` to skip it.

Multi-task runs require `integration-reviewer` `APPROVED` before `FINAL_VERIFYING`.

## Execution loop — by profile

### `strict` (per-task)

For each pending task in `.opencode/plans/PLAN.md`:

1. Ensure task-N.md template completeness (drift SHA, STOP, gates, impact section).
2. Pre-impact this task:
   ```bash
   nexus impact --json --targets <csv> --out .opencode/impact/task-N.json
   ```
3. Branch `feature/task-N-<slug>` per `branch_policy` isolated|stacked. Prefer a dedicated worktree.
4. Bug-fix: dispatch `diagnostician` to reproduce, then implementer with TDD red → green.
5. Dispatch **one implementer per task** — reference-first prompt (`implementer-prompt.md`). Do not write production code in the orchestrator turn.
6. Mandatory dual review — `dispatch.md`: spec-reviewer → APPROVED → code-reviewer → APPROVED.
7. Outcome memory per `lessonPolicy: every-task`.
8. Finishing/merge; script cleanup:
   ```bash
   bash scripts/nexus-branch-cleanup.sh --base <base> --out .opencode/handoffs/task-N-cleanup.json feature/task-N-<slug>
   ```

### `balanced` / `fast` (batched units, still one implementer per task)

For each pending **execution unit**:

1. Pre-impact once for the unit's planned files:
   ```bash
   nexus impact --json --targets <csv>
   ```
   After implementation, VERIFYING performs post-impact on the actual git range. Recompute if the implementer edits outside declared `allowed_files`.
2. Create **one feature branch**: `feature/<feature-slug>`.
3. Dispatch **one implementer per task** in the unit (never one implementer for a multi-task batch). Isolated worktree + non-empty `allowed_files`. Handoff: `.opencode/handoffs/<task-id>-implementer.json`.
4. Review per risk matrix (`profiles.md` / `config/workflow-profiles.json`):
   - documentation → skip review (engine still runs verification unless exempt)
   - low/medium unified classes → `unified-reviewer` once
   - public-api / security / migration / HIGH impact → dual spec then code
5. If the unit has more than one task → dispatch `integration-reviewer` before `FINAL_VERIFYING`.
6. If HIGH impact is discovered mid-flight → escalate to dual review.
7. LESSONS: write only when `lessonPolicy` says noteworthy.
8. Merge feature branch into base when the unit is done (`merge_policy: always_to_base`).
9. Script cleanup of the feature branch (not an agent).

## Plan completion

1. Finishing skill for any remaining dispositions.
2. Build `branches_to_delete` from CONTEXT (`merged`/`discarded`, no `deleted_at`).
3. If non-empty:
   ```bash
   git checkout <base_branch>
   bash scripts/nexus-branch-cleanup.sh --base <base> --out .opencode/handoffs/plan-cleanup.json <branches...>
   ```
4. Set `cleanup_status: complete`. Do not dispatch implementer for cleanup.

## Task-N.md template

Every task file written during orchestration MUST follow:

```markdown
# Task N: <title>
> slug: <slug> | effort: XS|S|M|L | confidence: LOW|MEDIUM|HIGH | depends: none | task-2
> plan_commit: <short-sha> (<full-sha>) | base: <base_branch> | branch: feature/task-N-<slug> OR feature/<feature-slug>
> generated: <ISO timestamp>
> impact: .opencode/impact/<task-or-unit>.json (risk, confidence, phase pre|post)
> execution_unit: <id|none> | profile: fast|balanced|strict

## Goal
<one sentence, pasted from PLAN.md>

## Context & Evidence
- PLAN.md ref: `.opencode/plans/PLAN.md` task-N section
- Key files (file:line, personally verified in this session)
- Impact insight: dependents / related tests
- Past lesson (top matching from LESSONS, not full dump)

## Scope
- In: <files allowed to edit>  (required, non-empty)
- Out: <files DO NOT touch>
- Related callers (impact radius)

## Acceptance criteria
- [ ] Criterion 1
- [ ] Existing tests still pass: `<exact test command>`

## STOP conditions
- STOP if target file:line missing (drift)
- STOP if plan_commit drift / base moved incompatibly
- STOP if HIGH impact and dependent count grew beyond threshold
- <task-specific STOP>

## Verification gates
1. Baseline on base_branch (provider-run)
2. Task verification commands (provider re-runs at VERIFYING)
3. Post-impact check for callers

## Implementation sketch
- Step 1: ...

## Handoff contract
- Output path: `.opencode/handoffs/task-N-implementer.json`
- Required fields (schema 1.1): schema_version, run_id, unit_or_task, agent, base_commit, created_at, status, commit, drift_check, files_changed[], tests[], impact, notes_for_reviewer
- Never set verification_exempt
- Never invent verification_gates.pass or final_verification.ok
```

## Review dispatch

**Read [`dispatch.md`](dispatch.md)** and [`profiles.md`](profiles.md).

### Dual (strict or high-risk)

```bash
jq -e '.verdict=="APPROVED"' .opencode/handoffs/<id>-spec-reviewer.json
jq -e '.verdict=="APPROVED"' .opencode/handoffs/<id>-code-reviewer.json
```

### Unified (fast/balanced low-medium)

```bash
jq -e '.verdict=="APPROVED"' .opencode/handoffs/<id>-unified-reviewer.json
```

### Integration (multi-task)

```bash
jq -e '.verdict=="APPROVED"' .opencode/handoffs/<id>-integration-reviewer.json
```

Never self-review when a reviewer is required. Never parallelize spec+code when dual is required.

## Subagent context protocol (reference-first)

Prefer paths over pastes. Dispatch with:

- Task / execution-unit id and title
- Paths to read: task file(s), `execution-unit-<id>.json`, CONTEXT.md, impact path, LESSONS excerpt, handoff path
- Concise acceptance criteria summary
- Branch names, profile, plan_commit, `allowed_files`
- Impact risk + confidence (one line)
- STOP reminder + verification commands (informational — engine re-runs them)

Do not paste full LESSONS.md or full impact JSON into the prompt when files are available on disk.

## Drift handling

Reconcile on HIGH drift / missing file:line; do not silent-proceed on STOP.

## Hard Rules

- Honor `workflow_profile`. Never silently downgrade `strict`.
- Escalate to dual review on security / migration / public-api / HIGH impact even under fast/balanced.
- Prefer scripts for impact, cleanup, agent-call estimate, and jq gates — not LLM agents.
- Orchestrator may run `scripts/nexus-branch-cleanup.sh` (guarded). Do not raw `git branch -d` outside that script.
- Never mark done without required APPROVED handoff(s) for the active review policy.
- Never auto-continue past checkpoint when `execution_mode: checkpoint`.
- Pre-impact before implement; post-impact is engine-run at VERIFYING.
- Outcome memory: follow `lessonPolicy` for the active profile.
- Orchestrator never implements production code unless CONTEXT has exact `execution_mode: direct` and stored classification is `direct_eligible`.
- Orchestrator edits without implementer are limited to `.opencode/**` (+ script/git orchestration).
