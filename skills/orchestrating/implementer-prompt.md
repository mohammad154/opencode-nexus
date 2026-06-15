# Implementer Dispatch Template

Use this template when dispatching `implementer`.

```text
You are implementing task: [TASK_ID] [TASK_TITLE]

## Required Reading (do this first)
1. Read .opencode/tasks/task-N.md
2. Read .opencode/CONTEXT.md
3. Confirm you are on branch: [feature/task-N-slug]

## Acceptance Criteria
[Paste explicit acceptance criteria summary]

## Context
- Base branch: [base-branch]
- Feature branch: [feature/task-N-slug]
- Branch policy: [isolated | stacked] (from .opencode/CONTEXT.md)
- Handoff output path: .opencode/handoffs/task-N-implementer.json
- Constraints: follow project conventions, minimal scope

## Branch policy constraints (when isolated)
- Create the feature branch from base_branch only.
- Never merge, rebase, or cherry-pick from another task's feature branch.
- If prior task work is required on this branch, return BLOCKED and ask the orchestrator to merge the prior task into base_branch first.

## Instructions
1. Ask clarifying questions if anything is ambiguous.
2. Implement only this task.
3. Add or update tests relevant to this task.
4. Run verification commands.
5. Commit changes on the assigned feature branch (never on base branch).
6. Write handoff JSON to .opencode/handoffs/task-N-implementer.json
7. Return status and summary

## Report Format
Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
Commit: <short-hash>
Files Changed:
- <file>
Tests:
- <command>: <result>
Notes for reviewer:
- <important note>
```
