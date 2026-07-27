---
name: using-feature-branches
description: Use when starting task execution to isolate changes on feature branches and keep review diffs precise — supports per-task (strict) and per-feature (fast/balanced) policies
compatibility: opencode
---

# Using Feature Branches (V3)

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

Read `merge_policy` from `.opencode/CONTEXT.md`. Default to `always_to_base`.

When `merge_policy: always_to_base` (default):

- After the active **review unit** passes (task in strict, execution unit in fast/balanced), merge the feature branch into `base_branch` before starting the next unit.
- Do not ask whether to merge unless `merge_policy: prompt`.

## Branch policy (profile-aware)

Read `workflow_profile` and `branch_policy` from `.opencode/CONTEXT.md`.

| Profile / policy | Branch naming | Cadence |
|------------------|---------------|---------|
| `strict` / `isolated` | `feature/task-N-<slug>` | One branch per task from `base_branch` |
| `strict` / `stacked` | `feature/task-N-<slug>` | Task N+1 off task N (opt-in) |
| `balanced` / `fast` (`per-feature`) | `feature/<feature-slug>` | One branch per execution unit / feature |

Never commit directly to the base branch.

### `per-feature` (default for balanced/fast)

```bash
git checkout <base-branch>
git checkout -b feature/<feature-slug>
# implement all tasks in the execution unit
# review once
git checkout <base-branch>
git merge feature/<feature-slug>
bash scripts/nexus-branch-cleanup.sh --base <base-branch> --out .opencode/handoffs/<id>-cleanup.json feature/<feature-slug>
```

### `isolated` (default for strict)

Each task branch is created from `base_branch` only.

1. `git checkout <base-branch>`
2. `git checkout -b feature/task-N-<slug>`
3. Implement and commit
4. Review with `git diff <base-branch>...feature/task-N-<slug>`
5. Merge into `base_branch`; script-cleanup the task branch

**Forbidden when `branch_policy: isolated`:** merging/rebasing another task's feature branch into the current task branch; creating task N+1 off task N.

### `stacked` (opt-in only)

Use only when the user explicitly chose `stacked`.

1. Branch task N+1 off the previous task branch
2. Review with `git diff feature/task-N-<slug>...feature/task-N+1-<slug>`

## Isolation recovery

If a strict/isolated task branch already contains a prior task's commits, do not dispatch reviewers until fixed (merge prior → base, rebase current onto base, re-verify diff).

## Cleanup

Prefer `scripts/nexus-branch-cleanup.sh` (ancestor checks). Do not LLM-dispatch solely for `git branch -d`.
