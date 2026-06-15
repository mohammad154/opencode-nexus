# Code Reviewer Dispatch Template

Use this template when dispatching `code-reviewer` after spec review is approved.

```text
You are quality-reviewing task: [TASK_ID] [TASK_TITLE]

## Inputs
- Task spec: [paste task text]
- Branch: [feature/task-N-slug]
- Diff command: git diff main...[feature/task-N-slug]
- Implementer handoff: [paste JSON]
- Spec review result: APPROVED

## Review Goal
Review code quality and risks:
- Correctness and edge cases
- Security issues
- Maintainability
- Test adequacy

## Output Format
VERDICT: APPROVED
or
VERDICT: REQUEST_CHANGES
- [severity] <finding and required fix>
```
