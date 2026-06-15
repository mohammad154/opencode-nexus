---
name: orchestrating
description: Use to execute a plan through branch-scoped implementation, two-stage review, and structured handoffs
compatibility: opencode
---

# Orchestrating

## Prerequisites

- Confirm the workspace is a git repository before starting.
- Load `using-feature-branches` and record `base_branch` in `.opencode/CONTEXT.md`.

## Workflow preferences gate

Before the per-task loop (or when resuming if preferences are missing):

1. If `branch_policy` or `execution_mode` are unset in `.opencode/CONTEXT.md`, ask:
   - **Branch policy:** isolated (each task branches off `base_branch`, reviewable in isolation) or stacked (branch task N+1 off task N)?
   - **Execution mode:** checkpoint (pause after each task for inspect/merge) or continuous (run all remaining tasks)?
   - Recommend **isolated** and **checkpoint** for multi-task plans.
2. Record answers in `.opencode/CONTEXT.md`. Do not re-ask on resume unless the user requests a change.

Run the per-task loop for each pending task in `.opencode/plans/PLAN.md`.

## Per-Task Execution Loop

1. Write `.opencode/tasks/task-N.md` with full task text and acceptance criteria.
2. Create branch `feature/task-N-<slug>`:
   - `branch_policy: isolated` → from `base_branch` (`git checkout <base_branch>` then `git checkout -b feature/task-N-<slug>`)
   - `branch_policy: stacked` → from the previous task's feature branch
3. Update `.opencode/CONTEXT.md` with current task, branch, and `base_branch`.
4. Run **pre-dispatch branch validation** (when `branch_policy: isolated`) — see Hard Rules. If validation fails, run isolation recovery before continuing.
5. Dispatch `implementer` using `implementer-prompt.md` (include task file path and acceptance criteria).
6. Save implementer handoff JSON to `.opencode/handoffs/task-N-implementer.json`.
7. Dispatch `spec-reviewer` using `spec-reviewer-prompt.md`.
8. If spec review fails, route fixes back to implementer and repeat (max 3 loops, then escalate).
9. Dispatch `code-reviewer` using `code-reviewer-prompt.md`.
10. If code review fails, route fixes back to implementer and repeat.
11. Mark task done in `.opencode/CONTEXT.md` and `.opencode/plans/PLAN.md` (`- [x]`).
12. Complete the task based on `execution_mode`:
    - **`execution_mode: checkpoint`:**
      - Load `finishing-a-development-branch` for **this task's branch only**.
      - Set `current_phase: awaiting_checkpoint` and `next_action: continue task N+1` (or finish if last task).
      - **Stop.** Do not dispatch the next task until the user explicitly says to continue.
    - **`execution_mode: continuous`:**
      - Proceed to the next pending task.

On resume after checkpoint: `git checkout <base_branch>` and optionally `git pull` before creating the next isolated branch (user may have merged the prior task).

## Subagent context protocol

When dispatching subagents, always include:

- Task ID and title
- Paths: `.opencode/tasks/task-N.md`, `.opencode/CONTEXT.md`, handoff JSON path
- Acceptance criteria (concise summary)
- Feature branch name and base branch name
- `branch_policy` and `execution_mode` from `.opencode/CONTEXT.md`

Subagents must read the task file and context file at the start of their run.

## Hard Rules

- Never skip spec review.
- Never skip code review.
- Never merge task branches automatically without explicit user confirmation.
- Never auto-continue past a completed task when `execution_mode: checkpoint`.
- If a subagent returns BLOCKED or NEEDS_CONTEXT, resolve before continuing.
- **Pre-dispatch branch validation** (when `branch_policy: isolated`): before dispatching implementer or reviewers for task N, confirm the feature branch was created from `base_branch`, not branched off or merged with a prior task branch. Run `git diff <base_branch>...<feature-branch>` — it must not include files or commits belonging only to earlier unmerged tasks.
- If validation fails: do not dispatch subagents. Guide the user through **isolation recovery** (merge prior task to `base_branch`, rebase current task onto `base_branch`, re-verify diff). See `using-feature-branches`.
