---
name: nexus-orchestrating
description: Use to execute a plan through branch-scoped implementation with graph awareness, blast-radius checks, profile-aware review, outcome memory, and structured handoffs
compatibility: opencode
---

# Orchestrating (V3 — profiles)

## Prerequisites

- Confirm the workspace is a git repository before starting.
- Load `using-feature-branches` and record `base_branch` in `.opencode/CONTEXT.md`.
- Ensure `.opencode/knowledge/graph.json` exists — run `scripts/nexus-graph.sh` (reuses unchanged file-hash results; use `--force` only when needed).
- If `reconcile` was requested or drift is suspected, run `reconcile` skill before starting tasks.
- **Read [`profiles.md`](profiles.md)** — workflow profiles control branch/review/batch behavior.

## Workflow preferences gate

Before the execution loop (or when resuming if preferences are missing):

1. If `workflow_profile` is unset in `.opencode/CONTEXT.md`:
   - Classify (see `profiles.md` / `config/workflow-profiles.json`) or ask the user.
   - **Recommend `balanced`** for normal multi-task features.
   - Allow explicit override: `fast` | `balanced` | `strict`.
2. If `branch_policy`, `execution_mode`, or `branch_cleanup_policy` are unset:
   - Derive defaults from profile (see table in `profiles.md`).
   - `strict` → recommend `isolated` + `checkpoint` (legacy per-task).
   - `balanced`/`fast` → `branch_policy: per-feature`, `execution_mode: continuous` unless user wants checkpoint.
3. Set `branch_cleanup_policy: always` by default; `cleanupPolicy: script` (run `scripts/nexus-branch-cleanup.sh` — **never** dispatch an LLM solely to delete branches).
4. Run the agent-call estimate and show the user:
   ```bash
   node scripts/nexus-estimate-calls.js --tasks <N> --profile <profile>
   ```
   The old `nexus-estimate-cost` scripts are one-release compatibility shims only.
5. Record answers in `.opencode/CONTEXT.md`. Do not re-ask on resume unless the user requests a change.

## Pre-execution preamble (run once before first dispatch)

1. Read `.opencode/knowledge/LESSONS.md` if present — retrieve **top matching** entries by path/subsystem (not necessarily the full file). Write a short `.opencode/knowledge/LESSONS-excerpt.md` for subagents when helpful.
2. Ensure graph is fresh via **cache-by-file-hash/content**:
   ```bash
   bash scripts/nexus-graph.sh          # reuses results only for unchanged, matching file hashes
   # bash scripts/nexus-graph.sh --force  # only when forced / generator bump / user asks
   # bash scripts/nexus-graph.sh --docs-only-skip  # docs-only changes
   ```
   Do **not** dispatch the knowledge-graph agent just to run the script.
3. Record `verification_baseline` on `base_branch`. Parallelize independent checks (build/test/lint) when safe.
4. For `fast`/`balanced`: group pending tasks into **execution units** (see `profiles.md`). Write `.opencode/tasks/execution-unit-<id>.json` (+ optional `.md`).

## Execution loop — by profile

### `strict` (legacy per-task — unchanged safety model)

For each pending task in `.opencode/plans/PLAN.md`:

1. Ensure task-N.md template completeness (drift SHA, STOP, gates, blast section).
2. Blast **this task**:
   ```bash
   node scripts/nexus-blast.js --files <csv> --task N --mermaid
   ```
3. Branch `feature/task-N-<slug>` per `branch_policy` isolated|stacked.
4. Update CONTEXT; pre-dispatch branch validation; drift check.
5. Dispatch **implementer** (one task) — reference-first prompt (`implementer-prompt.md`). **Do not** write production code in the orchestrator turn.
6. **Mandatory dual review** — `dispatch.md`: spec-reviewer → APPROVED → code-reviewer → APPROVED.
7. Outcome memory per `lessonPolicy: every-task`.
8. Finishing/merge; **script cleanup**:
   ```bash
   bash scripts/nexus-branch-cleanup.sh --base <base> --out .opencode/handoffs/task-N-cleanup.json feature/task-N-<slug>
   ```
9. Checkpoint or continue per `execution_mode`.

On resume: checkout base; run graph script (unchanged files may reuse cached results); blast next task.

### `balanced` / `fast` (batched)

For each pending **execution unit**:

1. Collect Scope: In files across unit tasks → blast **once**:
   ```bash
   node scripts/nexus-blast.js --files <csv> --task <unit-id> --mermaid
   # writes .opencode/knowledge/blast/<unit-id>.md + .json
   ```
   Recompute only if implementer edits outside declared scope, or risk is MEDIUM/HIGH after implementation.
2. Create **one feature branch**: `feature/<feature-slug>` (not per tiny task).
3. Dispatch **one implementer** for all tasks in the unit (batch prompt). Handoff: `.opencode/handoffs/<unit-id>-implementer.json`. **Do not** write production code in the orchestrator turn — only `execution_mode: direct` in CONTEXT permits that.
4. **Review** per risk matrix (`profiles.md` / `config/workflow-profiles.json`):
   - documentation → skip review (still run verification gates)
   - low/medium unified classes → `unified-reviewer` once
   - public-api / security / migration / HIGH blast → dual spec then code (same as strict)
5. If HIGH blast discovered mid-flight → escalate to dual review.
6. LESSONS: write only when `lessonPolicy` says noteworthy (review findings, BLOCKED, surprise deps, lesson prevented error). `fast`/`balanced` default: noteworthy-only.
7. Merge feature branch into base when unit done (`merge_policy: always_to_base`).
8. Script cleanup of the feature branch (not an agent).

## Plan completion

1. Finishing skill for any remaining dispositions.
2. Build `branches_to_delete` from CONTEXT (`merged`/`discarded`, no `deleted_at`).
3. If non-empty:
   ```bash
   git checkout <base_branch>
   bash scripts/nexus-branch-cleanup.sh --base <base> --out .opencode/handoffs/plan-cleanup.json <branches...>
   ```
   For `discarded` not merged: add `--force-discard` only for those branches.
4. Set `cleanup_status: complete`. Do **not** dispatch implementer for cleanup.
5. Plan-level LESSONS reflect when noteworthy.

## Task-N.md template (enhanced — improve-grade)

Every task file written during orchestration MUST follow:

```markdown
# Task N: <title>
> slug: <slug> | effort: XS|S|M|L | confidence: LOW|MEDIUM|HIGH | depends: none | task-2
> plan_commit: <short-sha> (<full-sha>) | base: <base_branch> | branch: feature/task-N-<slug> OR feature/<feature-slug>
> generated: <ISO timestamp>
> graph: .opencode/knowledge/graph.json @ <graph timestamp or "missing – run nexus-graph.sh">
> blast: .opencode/knowledge/blast/<task-or-unit>.md (risk: LOW|MEDIUM|HIGH, score, if available)
> execution_unit: <id|none> | profile: fast|balanced|strict

## Goal
<one sentence, pasted from PLAN.md>

## Context & Evidence
- PLAN.md ref: `.opencode/plans/PLAN.md` task-N section
- Key files (file:line, personally verified in this session):
  - `src/foo.ts:42` – ...
- Graph insight: importers / hub proximity
- Past lesson (top matching from LESSONS, not full dump)

## Scope
- In: <files allowed to edit>
- Out: <files DO NOT touch>
- Related callers (blast radius)

## Acceptance criteria
- [ ] Criterion 1
- [ ] Existing tests still pass: `<exact test command>`

## STOP conditions
- STOP if target file:line missing (drift)
- STOP if plan_commit drift / base moved incompatibly
- STOP if HIGH blast and dependent count grew beyond threshold
- <task-specific STOP>

## Verification gates
1. Baseline on base_branch
2. Task verification commands
3. Blast check for callers

## Implementation sketch
- Step 1: ...

## Handoff contract
- Output path: `.opencode/handoffs/task-N-implementer.json` OR `.opencode/handoffs/<unit-id>-implementer.json`
- Required fields (schema 1.1): schema_version, run_id, unit_or_task, agent, base_commit, created_at, status, commit, verification_gates[], drift_check, files_changed[], tests[], blast, notes_for_reviewer
- Never set verification_exempt (run verification_policy only)
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

Never self-review when a reviewer is required. Never parallelize spec+code when dual is required.

## Subagent context protocol (reference-first)

Prefer **paths over pastes**. Dispatch with:

- Task / execution-unit id and title
- Paths to read: task file(s), `execution-unit-<id>.json`, CONTEXT.md, blast path, LESSONS-excerpt.md, handoff path
- Concise acceptance criteria summary (bullet list OK; do not paste entire PLAN.md)
- Branch names, profile, plan_commit
- Blast risk level (one line) — full Mermaid lives in the blast file
- STOP reminder + verification gate commands

Do **not** paste full LESSONS.md, full graph.json, or full blast markdown into the prompt when files are available on disk.

## Drift handling

Unchanged: reconcile on HIGH drift / missing file:line; do not silent-proceed on STOP.

## Hard Rules

- Honor `workflow_profile`. Never silently downgrade `strict`.
- Escalate to dual review on security / migration / public-api / HIGH blast even under fast/balanced.
- Prefer scripts for graph, blast, cleanup, agent-call estimate, and jq gates — not LLM agents.
- Orchestrator may run `scripts/nexus-branch-cleanup.sh` (guarded). Do **not** raw `git branch -d` outside that script.
- Never mark done without required APPROVED handoff(s) for the active review policy.
- Never auto-continue past checkpoint when `execution_mode: checkpoint`.
- Blast-before-implement (per task in strict; per execution unit in balanced/fast).
- Outcome memory: follow `lessonPolicy` for the active profile.
- **Orchestrator never implements production code** unless CONTEXT has exact `execution_mode: direct`. Pasted plans / “please implement” do **not** authorize self-coding. Dispatch implementer; if dispatch fails, STOP and report — no self-fallback.
- Orchestrator edits without implementer are limited to `.opencode/**` (+ script/git orchestration).
