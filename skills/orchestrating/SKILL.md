---
name: orchestrating
description: Use to execute a plan through branch-scoped implementation with graph awareness, blast-radius checks, two-stage review, outcome memory, and structured handoffs
compatibility: opencode
---

# Orchestrating

## Prerequisites

- Confirm the workspace is a git repository before starting.
- Load `using-feature-branches` and record `base_branch` in `.opencode/CONTEXT.md`.
- Ensure `.opencode/knowledge/graph.json` exists — if missing, run `scripts/nexus-graph.sh` (auto-build; requires only shell + optional node/jq, no pip).
- If `reconcile` was requested or drift is suspected, run `reconcile` skill before starting tasks.

## Workflow preferences gate

Before the per-task loop (or when resuming if preferences are missing):

1. If `branch_policy` or `execution_mode` are unset in `.opencode/CONTEXT.md`, ask:
   - **Branch policy:** isolated (each task branches off `base_branch`, reviewable in isolation) or stacked (branch task N+1 off task N)?
   - **Execution mode:** checkpoint (pause after each task for inspect/merge) or continuous (run all remaining tasks)?
   - Recommend **isolated** and **checkpoint** for multi-task plans.
2. Record answers in `.opencode/CONTEXT.md`. Do not re-ask on resume unless the user requests a change.

Run the per-task loop for each pending task in `.opencode/plans/PLAN.md`.

## Pre-task preamble (run once before first dispatch)

1. Read `.opencode/knowledge/LESSONS.md` if present — carry failure patterns into reviewer guidance.
2. Run `node scripts/nexus-graph.js` or `bash scripts/nexus-graph.sh` to ensure graph is fresh (safe to run; outputs to `.opencode/knowledge/graph.json` which is git-ignored friendly).
3. Record `verification_baseline` outcome: run build/test/lint as detected on base_branch + log result — if baseline was already failing, note so; do not let baseline failures block task N's review unless task N touches failing area (STOP condition handles this).

## Per-Task Execution Loop

1. Write or verify `.opencode/tasks/task-N.md` follows the enhanced template (see below). If it lacks:
   - drift SHA, plan_commit, STOP conditions, verification gates, blast-radius section → patch it now from PLAN.md + graph.
2. Resolve target files for this task (from task-N.md Scope: In). Run blast analysis:
   ```bash
   node scripts/nexus-blast.js --files <csv-of-target-files> --task N --mermaid
   # fallback: bash scripts/nexus-blast.sh
   ```
   This writes `.opencode/knowledge/blast/task-N.md` + `.json` with Mermaid diagram and risk level (LOW/MEDIUM/HIGH).
   If graph missing, graph build runs automatically inside blast script.
   If blast level is HIGH, add a note to task-N.md's blast section and flag to spec-reviewer to watch scope creep.
3. Create branch `feature/task-N-<slug>`:
   - `branch_policy: isolated` → from `base_branch` (`git checkout <base_branch>` then `git checkout -b feature/task-N-<slug>`)
   - `branch_policy: stacked` → from the previous task's feature branch
4. Update `.opencode/CONTEXT.md` with current task, branch, base_branch, plan_commit, knowledge freshness (graph timestamp).
5. Run **pre-dispatch branch validation** (when `branch_policy: isolated`) — see Hard Rules. If validation fails, run isolation recovery before continuing.
6. Run **drift check**: `git rev-parse --short HEAD` vs `plan_commit` in CONTEXT.md; if base has moved > threshold or task file's STOP file:line assumption no longer holds, escalate (see Drift handling).
7. Dispatch `implementer` using `implementer-prompt.md` (include task file path, acceptance criteria, blast report path, graph summary, LESSONS excerpt).
8. Save implementer handoff JSON to `.opencode/handoffs/task-N-implementer.json`.
9. Dispatch `spec-reviewer` using `spec-reviewer-prompt.md`.
10. If spec review fails, route fixes back to implementer and repeat (max 3 loops, then escalate).
11. Dispatch `code-reviewer` using `code-reviewer-prompt.md`.
12. If code review fails, route fixes back to implementer and repeat.
13. **Outcome memory**: After both reviews pass, write entry to `.opencode/knowledge/LESSONS.md` via the pattern in that file (see finishing-a-development-branch + outcome-memory). Include: task id, what was changed, blast level, what reviewers flagged, lesson learned.
14. Mark task done in `.opencode/CONTEXT.md` and `.opencode/plans/PLAN.md` (`- [x]`). Update `task_branches` dispositions later via finishing skill.
15. Complete the task based on `execution_mode`:
    - **`execution_mode: checkpoint`:**
      - Load `finishing-a-development-branch` for **this task's branch only**.
      - Set `current_phase: awaiting_checkpoint` and `next_action: continue task N+1` (or finish if last task).
      - **Stop.** Do not dispatch the next task until the user explicitly says to continue.
    - **`execution_mode: continuous`:**
      - Proceed to the next pending task.

On resume after checkpoint: `git checkout <base_branch>` and optionally `git pull` before creating the next isolated branch (user may have merged the prior task). Re-run graph build + blast for next task.

## Plan completion

When all tasks in `.opencode/plans/PLAN.md` are marked done:

1. Load `finishing-a-development-branch` if not already run for the last task (record `task_branches` dispositions).
2. Build `branches_to_delete` from `.opencode/CONTEXT.md` `task_branches` where `disposition` is `merged` or `discarded`.
3. If the list is empty, skip cleanup dispatch.
4. `git checkout <base_branch>` (orchestrator — never delete branches directly).
5. Dispatch `implementer` using `branch-cleanup-prompt.md` with the branch list and dispositions.
6. Save handoff to `.opencode/handoffs/plan-cleanup-implementer.json`.
7. Update `.opencode/CONTEXT.md` with `cleanup_status: complete` and the removed branch names.
8. Generate final outcome summary: append to `.opencode/knowledge/LESSONS.md` a plan-level reflect entry (what went well, surprise dependencies discovered via graph, recommendations for next plan).
9. If implementer returns `BLOCKED`, surface errors to the user; do not claim cleanup succeeded.

Edge cases:
- **No eligible branches:** user kept all branches or has open PRs — skip dispatch.
- **Delete fails** (`git branch -d` on unmerged): implementer returns `BLOCKED`; do not force-delete unless disposition is `discarded`.
- **Stacked policy:** same cleanup rules; disposition drives eligibility.
- **Continuous mode:** run plan-end cleanup once after the final task's reviews; default disposition to `kept` unless user explicitly requests merge or discard.

## Task-N.md template (enhanced — improve-grade)

Every task file written during orchestration MUST follow:

```markdown
# Task N: <title>
> slug: <slug> | effort: XS|S|M|L | confidence: LOW|MEDIUM|HIGH | depends: none | task-2
> plan_commit: <short-sha> (<full-sha>) | base: <base_branch> | branch: feature/task-N-<slug>
> generated: <ISO timestamp>
> graph: .opencode/knowledge/graph.json @ <graph timestamp or "missing – run nexus-graph.sh">
> blast: .opencode/knowledge/blast/task-N.md (risk: LOW|MEDIUM|HIGH, score, if available)

## Goal
<one sentence, pasted from PLAN.md>

## Context & Evidence
- PLAN.md ref: `.opencode/plans/PLAN.md` task-N section
- Key files (file:line, personally verified in this session):
  - `src/foo.ts:42` – ...
  - `src/bar.test.ts:5-20` – exemplar pattern
- Graph insight:
  - importers of target files: <top 5 from graph.json or "run nexus-graph.sh">
  - hub proximity: <if target adjacent to god node>
- Past lesson (from LESSONS.md when present):
  - e.g. "task-2 modified auth.ts and broke sessions – we added integration test in task-2"

## Scope
- In: <files allowed to edit>
- Out: <files DO NOT touch – adjacent but unrelated>
- Related callers (blast radius – auto-generated by nexus-blast.js):
  <!-- PASTE from .opencode/knowledge/blast/task-N.md or leave placeholder for orchestrator pre-dispatch -->
  - `src/caller1.ts` (depth 1, direct)
  - `src/caller2.ts` (depth 2 via caller1)
  - Mermaid diagram reference: see blast/task-N.md

## Acceptance criteria
- [ ] Criterion 1 – machine-checkable, includes positive case
- [ ] Criterion 2 – includes negative case
- [ ] Existing tests still pass: `<exact test command>`

## STOP conditions (if any true → BLOCKED, do not improvise)
- STOP if target file no longer contains expected symbol at file:line (drift)
- STOP if `git rev-parse HEAD` diverges > 50 commits from plan_commit or base_branch moved in a way described in reconcile
- STOP if baseline verification (`npm test` on base) was already failing for this area
- STOP if blast shows HIGH risk and dependent file count grew > threshold vs when plan written
- <task-specific STOP>

## Verification gates (exact commands, expected output)
1. Baseline (on base_branch, before starting): `<build/test/lint command>` → <expected>
2. Task verification:
   - `npm run build` – expected: exits 0
   - `npm test -- <new test file>` – expected: N passing
   - `git diff <base>...feature/task-N-<slug> --stat` – only expected files changed
3. Blast check:
   - Confirm callers from blast report still pass / no new runtime errors

## Implementation sketch
- Step 1: ...
- Step 2: ...

## Handoff contract
- Output path: `.opencode/handoffs/task-N-implementer.json`
- Required fields: status (DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT), commit hash, files_changed[], tests[], blast_verified boolean, notes_for_reviewer
```

## Subagent context protocol

When dispatching subagents, always include:
- Task ID and title
- Paths: `.opencode/tasks/task-N.md`, `.opencode/CONTEXT.md`, `.opencode/knowledge/graph.json`, `.opencode/knowledge/blast/task-N.md`, `.opencode/knowledge/LESSONS.md`, handoff JSON path
- Acceptance criteria (concise summary)
- Feature branch name and base branch name
- branch_policy and execution_mode from CONTEXT.md
- plan_commit + drift check instruction
- Blast level + related callers (paste from blast report)
- STOP conditions (at least mention that they exist in task file)
- Verification gates (exact commands – not "run tests")

Subagents must read the task file and context file at the start of their run, plus blast report and LESSONS when present.

## Drift handling

If drift detected before dispatch:
- If plan_commit vs current HEAD > 50 commits or base_branch changed → load `reconcile` skill to verify whether task still valid.
- If target file:line missing → re-read file, update task-N.md Evidence, or return BLOCKED to user asking to re-run writing-plans or reconcile.
- Do not silently proceed when STOP conditions triggered.

If drift detected during implementer:
- Implementer returns BLOCKED with evidence (expected file:line not found, graph changed, test infra broken). Orchestrator handles via reconcile or by re-planning task.

## Hard Rules

- Never skip spec review.
- Never skip code review.
- Never merge task branches automatically without explicit user confirmation.
- Never delete task branches directly (`git branch -d` / `-D`); delegate deletion to `implementer` at plan completion.
- Never auto-continue past a completed task when `execution_mode: checkpoint`.
- If a subagent returns BLOCKED or NEEDS_CONTEXT, resolve before continuing.
- **Pre-dispatch branch validation** (when `branch_policy: isolated`): before dispatching implementer or reviewers for task N, confirm the feature branch was created from `base_branch`, not branched off or merged with a prior task branch. Run `git diff <base_branch>...<feature-branch>` — it must not include files or commits belonging only to earlier unmerged tasks.
- If validation fails: do not dispatch subagents. Guide the user through **isolation recovery** (merge prior task to `base_branch`, rebase current task onto `base_branch`, re-verify diff). See `using-feature-branches`.
- **Blast-before-implement:** every task dispatch must have a blast report (or graph-missing note). If HIGH risk, spec-reviewer must explicitly approve scope.
- **Drift check:** every task file must have plan_commit and STOP. Executor must run drift check before editing.
- **Outcome memory:** after each approved task, write LESSONS entry; include blast level and graph insight.
