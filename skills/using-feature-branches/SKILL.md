---
name: using-feature-branches
description: Use when starting task execution to isolate changes on feature branches and keep review diffs precise
compatibility: opencode
---

# Using Feature Branches

Branch policy:

- Never commit directly to `main` or `master`.
- Create one branch per task: `feature/task-N-<slug>`.
- Keep commits scoped to the active task.
- Review scope with `git diff main...<branch>`.

Recommended branch flow:

1. `git checkout main`
2. `git pull` (if project policy allows)
3. `git checkout -b feature/task-N-<slug>`
4. Implement and commit
5. Review
6. Merge or keep branch based on user choice
