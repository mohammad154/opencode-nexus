---
name: orchestrating
description: Use to execute a plan through branch-scoped implementation, two-stage review, and structured handoffs
compatibility: opencode
---

# Orchestrating

## Prerequisites

- Confirm the workspace is a git repository before starting.
- Load `using-feature-branches` and record `base_branch` in `.opencode/CONTEXT.md`.

Run this loop for each task in `.opencode/plans/PLAN.md`.

## Per-Task Execution Loop

1. Write `.opencode/tasks/task-N.md` with full task text and acceptance criteria.
2. Create branch `feature/task-N-<slug>` from the detected base branch.
3. Update `.opencode/CONTEXT.md` with current task, branch, and `base_branch`.
4. Dispatch `implementer` using `implementer-prompt.md` (include task file path and acceptance criteria).
5. Save implementer handoff JSON to `.opencode/handoffs/task-N-implementer.json`.
6. Dispatch `spec-reviewer` using `spec-reviewer-prompt.md`.
7. If spec review fails, route fixes back to implementer and repeat (max 3 loops, then escalate).
8. Dispatch `code-reviewer` using `code-reviewer-prompt.md`.
9. If code review fails, route fixes back to implementer and repeat.
10. Mark task done in context state and continue.

## Subagent context protocol

When dispatching subagents, always include:

- Task ID and title
- Paths: `.opencode/tasks/task-N.md`, `.opencode/CONTEXT.md`, handoff JSON path
- Acceptance criteria (concise summary)
- Feature branch name and base branch name

Subagents must read the task file and context file at the start of their run.

## Hard Rules

- Never skip spec review.
- Never skip code review.
- Never merge task branches automatically without explicit user confirmation.
- If a subagent returns BLOCKED or NEEDS_CONTEXT, resolve before continuing.
