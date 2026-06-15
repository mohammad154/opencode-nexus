---
name: using-feature-branches
description: Use when starting task execution to isolate changes on feature branches and keep review diffs precise
compatibility: opencode
---

# Using Feature Branches

## Prerequisites

- The project must be a git repository (`git init` if needed).
- If git is unavailable, stop and ask the user before continuing.

## Detect the base branch

Do not assume `main`. Resolve the base branch before creating feature branches or running diffs:

1. Read `base_branch` from `.opencode/CONTEXT.md` if set.
2. Else try: `git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'`
3. Else try local default: `main`, then `master`, then `develop`.
4. Record the chosen value in `.opencode/CONTEXT.md` as `base_branch`.

Review diff command:

```bash
git diff <base-branch>...<feature-branch>
```

## Branch policy

- Never commit directly to the base branch.
- Create one branch per task: `feature/task-N-<slug>`.
- Keep commits scoped to the active task.

## Recommended branch flow

1. `git checkout <base-branch>`
2. `git pull` (if project policy allows)
3. `git checkout -b feature/task-N-<slug>`
4. Implement and commit
5. Review with `git diff <base-branch>...feature/task-N-<slug>`
6. Merge or keep branch based on user choice
