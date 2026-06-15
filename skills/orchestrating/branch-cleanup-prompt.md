# Branch Cleanup Dispatch Template

Use this template when dispatching `implementer` for plan-end branch cleanup.

```text
You are performing branch cleanup (not implementation).

## Required Reading (do this first)
1. Read .opencode/CONTEXT.md
2. Confirm you are on branch: [base-branch] (orchestrator should have checked out already)

## Branches to Delete
[Paste list — one per line, with disposition]
- feature/task-1-<slug> (disposition: merged)
- feature/task-2-<slug> (disposition: discarded)

## Context
- Base branch: [base-branch]
- Handoff output path: .opencode/handoffs/plan-cleanup-implementer.json

## Instructions
1. Run `git branch --show-current` and confirm it matches [base-branch]. If not, return BLOCKED.
2. For each branch in the list:
   - disposition `merged` → `git branch -d <branch>`
   - disposition `discarded` → `git branch -D <branch>`
3. Do not delete branches not listed above.
4. If `git branch -d` fails for a `merged` branch, return BLOCKED with the git error (do not force-delete).
5. Write handoff JSON to .opencode/handoffs/plan-cleanup-implementer.json with:
   - deleted: [branch names successfully removed]
   - skipped: [branches not in the list or already gone]
   - failed: [{ branch, error }] for any deletion that failed
6. Return status and summary.

## Report Format
Status: DONE | BLOCKED
Deleted:
- <branch>
Skipped:
- <branch>
Failed:
- <branch>: <error>
Notes:
- <important note>
```
