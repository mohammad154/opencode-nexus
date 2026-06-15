---
name: orchestrating
description: Use to execute a plan through branch-scoped implementation, two-stage review, and structured handoffs
compatibility: opencode
---

# Orchestrating

Run this loop for each task in `.opencode/plans/PLAN.md`.

## Per-Task Execution Loop

1. Write `.opencode/tasks/task-N.md` with full task text and acceptance criteria.
2. Create branch `feature/task-N-<slug>`.
3. Update `.opencode/CONTEXT.md` with current task and branch.
4. Dispatch `implementer` using `implementer-prompt.md`.
5. Save implementer handoff JSON to `.opencode/handoffs/task-N-implementer.json`.
6. Dispatch `spec-reviewer` using `spec-reviewer-prompt.md`.
7. If spec review fails, route fixes back to implementer and repeat.
8. Dispatch `code-reviewer` using `code-reviewer-prompt.md`.
9. If code review fails, route fixes back to implementer and repeat.
10. Mark task done in context state and continue.

## Hard Rules

- Never skip spec review.
- Never skip code review.
- Never merge task branches automatically without explicit user confirmation.
- If a subagent returns BLOCKED or NEEDS_CONTEXT, resolve before continuing.
