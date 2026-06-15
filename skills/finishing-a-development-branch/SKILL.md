---
name: finishing-a-development-branch
description: Use after all tasks pass review to choose how to finalize the branch safely
compatibility: opencode
---

# Finishing a Development Branch

## Per-task checkpoint

When `execution_mode: checkpoint` in `.opencode/CONTEXT.md`, run this skill **after each task** passes both reviews — not only after all tasks complete.

Scope all options to the **current task branch** named in `.opencode/CONTEXT.md`.

Present these choices:

1. Merge locally into `base_branch`.
2. Push branch and create a PR.
3. Keep branch unmerged for later.
4. Discard branch changes.

After the user chooses:

- Update `.opencode/CONTEXT.md` with merge state.
- Remind the user the orchestrator will wait for an explicit "continue task N+1" before the next task starts.

## All tasks complete

After all tasks are approved (or when the user requests final integration on the last task), present the same choices for the final branch if not already integrated.

1. Merge locally into `base_branch` (read from `.opencode/CONTEXT.md`; detect dynamically if unset — do not assume `main`).
2. Push branch and create a PR.
3. Keep branch unmerged for later.
4. Discard branch changes.

## Detect the base branch

Before merge or PR actions, resolve `base_branch`:

1. Read `base_branch` from `.opencode/CONTEXT.md` if set.
2. Else try: `git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'`
3. Else try local default: `main`, then `master`, then `develop`.
4. Record the chosen value in `.opencode/CONTEXT.md` as `base_branch`.

Rules:

- Never force-push to `main` or `master`.
- Confirm user intent before merge or discard actions.
- If creating a PR, include task summary and test evidence.
- Update `.opencode/CONTEXT.md` with final state.
