---
name: using-feature-branches
description: Use when starting execution-unit work to isolate changes on feature branches and keep review diffs precise
compatibility: opencode
---

# Using Feature Branches (V5)

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

- After the active **execution unit** passes its task-scoped review, merge the
  feature branch into `base_branch` before starting the next unit.
- Do not ask whether to merge unless `merge_policy: prompt`.

## Branch policy

Read `branch_policy` from `.opencode/CONTEXT.md`; the default workflow uses
`per-feature` unless the plan explicitly requires isolated unit branches.

| Policy | Branch naming | Cadence |
|--------|---------------|---------|
| `per-feature` | `feature/<feature-slug>` | One branch for the cohesive execution plan |
| `isolated` | `feature/unit-N-<slug>` | One branch per execution unit from `base_branch` |
| `stacked` (explicit opt-in) | `feature/unit-N-<slug>` | Each unit starts from the prior unit branch |

Never commit directly to the base branch.

### `per-feature` (default)

```bash
git checkout <base-branch>
git checkout -b feature/<feature-slug>
# implement the complete cohesive execution unit
# review once
git checkout <base-branch>
git merge feature/<feature-slug>
bash scripts/nexus-branch-cleanup.sh --base <base-branch> --out .opencode/handoffs/<id>-cleanup.json feature/<feature-slug>
```

### `isolated` (when the plan requires independent unit branches)

Each execution-unit branch is created from `base_branch` only.

1. `git checkout <base-branch>`
2. `git checkout -b feature/unit-N-<slug>`
3. Implement and commit
4. Review with `git diff <base-branch>...feature/unit-N-<slug>`
5. Merge into `base_branch`; script-cleanup the execution-unit branch

**Forbidden when `branch_policy: isolated`:** merging/rebasing another unit's
feature branch into the current unit branch; creating unit N+1 off unit N.

### `stacked` (opt-in only)

Use only when the user explicitly chose `stacked`.

1. Branch unit N+1 off the previous unit branch
2. Review with `git diff feature/unit-N-<slug>...feature/unit-N+1-<slug>`

## Isolation recovery

If an isolated execution-unit branch already contains a prior unit's commits,
do not dispatch reviewers until fixed (merge prior → base, rebase current onto
base, re-verify diff).

## Cleanup

Prefer `scripts/nexus-branch-cleanup.sh` (ancestor checks). Do not LLM-dispatch solely for `git branch -d`.
