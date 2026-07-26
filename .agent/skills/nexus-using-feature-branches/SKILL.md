---
name: nexus-using-feature-branches
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

## Merge policy (project default)

Read `merge_policy` from `.opencode/CONTEXT.md`. Default to `always_to_base` for this project.

When `merge_policy: always_to_base` (default):

- **After each task passes spec + code review**, merge the feature branch into `base_branch` before starting the next task.
- The next task branch must be created from the updated `base_branch` so it includes prior work.
- Do not ask whether to merge — merging is the required integration step unless the user sets `merge_policy: prompt`.

```bash
git checkout <base-branch>
git merge feature/task-N-<slug>   # fast-forward or merge commit
git checkout -b feature/task-N+1-<slug>
```

Override only when the user sets `merge_policy: prompt` in `.opencode/CONTEXT.md` (present choices via `finishing-a-development-branch`).

## Branch policy

Read `branch_policy` from `.opencode/CONTEXT.md`. Default to `isolated` when unset.

- Never commit directly to the base branch.
- Create one branch per task: `feature/task-N-<slug>`.
- Keep commits scoped to the active task.

### `isolated` (default, recommended)

Each task branch is created from `base_branch` only. Reviews show only that task's changes.

1. `git checkout <base-branch>`
2. `git pull` (if project policy allows)
3. `git checkout -b feature/task-N-<slug>`
4. Implement and commit
5. Review with `git diff <base-branch>...feature/task-N-<slug>`
6. After reviews pass: merge into `base_branch` (see Merge policy). Record disposition `merged`.

**Never** branch task N+1 off `feature/task-N-...`.

Always merge task N into `base_branch` before starting task N+1 (when `merge_policy: always_to_base`). Create the next branch from the updated `base_branch` — **not** by merging task N's branch into task N+1's branch.

**Forbidden when `branch_policy: isolated`:**

- `git merge feature/task-N-...` while on `feature/task-N+1-...`
- `git rebase feature/task-N-...` onto task N+1
- Creating task N+1 by branching off `feature/task-N-...` instead of `base_branch`

### `stacked` (opt-in only)

Use only when the user explicitly chose `stacked` in `.opencode/CONTEXT.md`.

1. Branch task N+1 off the previous task branch: `feature/task-N-<slug>`
2. Review with `git diff feature/task-N-<slug>...feature/task-N+1-<slug>`

## Isolation recovery

If a task branch already contains a prior task's commits (e.g. fast-forward merge of task N into task N+1), do not dispatch reviewers until fixed.

1. Merge the prior task branch into `base_branch`.
2. Rebase the current task branch onto `base_branch`.
3. Verify: `git diff <base-branch>...<feature-branch>` shows **only** the current task's changes.

```bash
git checkout <base-branch>
git merge feature/task-N-<slug>

git checkout feature/task-N+1-<slug>
git rebase <base-branch>

git diff <base-branch>...feature/task-N+1-<slug>
```

If rebase conflicts, resolve preserving the current task's intent, then re-run the diff check.
