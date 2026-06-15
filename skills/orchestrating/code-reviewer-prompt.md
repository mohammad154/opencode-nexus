# Code Reviewer Dispatch Template

Use this template when dispatching `code-reviewer` after spec review is approved.

```text
You are quality-reviewing task: [TASK_ID] [TASK_TITLE]

## Required Reading (do this first)
1. Read .opencode/tasks/task-N.md
2. Read .opencode/handoffs/task-N-implementer.json
3. Read .opencode/handoffs/task-N-spec-reviewer.json
4. Read .opencode/CONTEXT.md for base_branch

## Inputs
- Base branch: [base-branch]
- Feature branch: [feature/task-N-slug]
- Diff command: git diff [base-branch]...[feature/task-N-slug]
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

Also write review notes to .opencode/handoffs/task-N-code-reviewer.json
```
