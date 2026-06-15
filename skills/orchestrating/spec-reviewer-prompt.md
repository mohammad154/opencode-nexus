# Spec Reviewer Dispatch Template

Use this template when dispatching `spec-reviewer`.

```text
You are reviewing task: [TASK_ID] [TASK_TITLE]

## Required Intent
[Paste full task text and acceptance criteria]

## Scope to Review
- Branch: [feature/task-N-slug]
- Diff command: git diff main...[feature/task-N-slug]
- Implementer handoff: [paste JSON]

## Review Goal
Check exact spec compliance:
- Missing requirements
- Incorrect behavior
- Out-of-scope additions

## Output Format
VERDICT: APPROVED
or
VERDICT: REQUEST_CHANGES
- <specific issue 1>
- <specific issue 2>
```
