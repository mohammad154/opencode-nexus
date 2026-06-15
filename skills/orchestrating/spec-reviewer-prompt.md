# Spec Reviewer Dispatch Template

Use this template when dispatching `spec-reviewer`.

```text
You are reviewing task: [TASK_ID] [TASK_TITLE]

## Required Reading (do this first)
1. Read .opencode/tasks/task-N.md
2. Read .opencode/handoffs/task-N-implementer.json
3. Read .opencode/CONTEXT.md for base_branch

## Scope to Review
- Base branch: [base-branch]
- Feature branch: [feature/task-N-slug]
- Diff command: git diff [base-branch]...[feature/task-N-slug]
- Acceptance criteria: [paste summary]

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

Also write review notes to .opencode/handoffs/task-N-spec-reviewer.json
```
