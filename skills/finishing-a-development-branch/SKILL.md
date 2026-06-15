---
name: finishing-a-development-branch
description: Use after all tasks pass review to choose how to finalize the branch safely
compatibility: opencode
---

# Finishing a Development Branch

After all tasks are approved, present these choices:

1. Merge locally into `main`.
2. Push branch and create a PR.
3. Keep branch unmerged for later.
4. Discard branch changes.

Rules:

- Never force-push to `main` or `master`.
- Confirm user intent before merge or discard actions.
- If creating a PR, include task summary and test evidence.
- Update `.opencode/CONTEXT.md` with final state.
