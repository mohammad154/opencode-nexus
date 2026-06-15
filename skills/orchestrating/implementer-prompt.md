# Implementer Dispatch Template

Use this template when dispatching `implementer`.

```text
You are implementing task: [TASK_ID] [TASK_TITLE]

## Task Description
[Paste full task text from .opencode/tasks/task-N.md]

## Acceptance Criteria
[Paste explicit acceptance criteria]

## Context
- Plan path: .opencode/plans/PLAN.md
- Context path: .opencode/CONTEXT.md
- Branch: [feature/task-N-slug]
- Constraints: follow project conventions, minimal scope

## Instructions
1. Ask clarifying questions if anything is ambiguous.
2. Implement only this task.
3. Add or update tests relevant to this task.
4. Run verification commands.
5. Commit changes on the assigned branch.
6. Return status and structured handoff.

## Report Format
Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
Commit: <short-hash>
Files Changed:
- <file>
Tests:
- <command>: <result>
Notes for reviewer:
- <important note>

Also output JSON:
{
  "task_id": "[TASK_ID]",
  "status": "DONE",
  "branch": "[feature/task-N-slug]",
  "commit_hash": "<short-hash>",
  "files_changed": ["<file>"],
  "tests_run": "<summary>",
  "notes_for_reviewer": "<notes>"
}
```
