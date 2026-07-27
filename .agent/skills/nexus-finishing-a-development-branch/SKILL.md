---
name: nexus-finishing-a-development-branch
description: Use after tasks or execution units pass review to finalize the branch safely — with outcome memory (LESSONS) capture, script cleanup, and reconcile awareness
compatibility: opencode
---

# Finishing a Development Branch (V3 – profiles + script cleanup)

## Checkpoint scope

When `execution_mode: checkpoint` in `.opencode/CONTEXT.md`, run this skill after each **review unit** passes:

- `strict`: after each task’s dual review
- `balanced` / `fast`: after each execution unit’s review (unified or dual)

Scope to the **current feature branch** named in `.opencode/CONTEXT.md`.

Read `merge_policy` (default `always_to_base`) and `branch_cleanup_policy` (default `always`).
Read `workflow_profile` and `lessonPolicy`.

### `merge_policy: always_to_base` (default)

After reviews pass:

1. Merge locally into `base_branch`.
2. Record disposition `merged` in `task_branches` (and/or `execution_units`).
3. Update `.opencode/CONTEXT.md`.
4. **Branch cleanup** (when `branch_cleanup_policy: always`): run the **script**, not an agent:
   ```bash
   bash scripts/nexus-branch-cleanup.sh --base <base_branch> \
     --out .opencode/handoffs/<id>-cleanup.json \
     <feature-branch>
   ```
   For `discarded` unmerged branches only: add `--force-discard`.
5. **Outcome memory**: follow `lessonPolicy` (`every-task` under strict; `noteworthy-only` under fast/balanced — see `outcome-memory`).
6. If checkpoint mode, wait for explicit continue before the next unit/task.

### `merge_policy: prompt` (opt-in only)

Present: merge locally / push PR / keep / discard. Map to dispositions below. Then script cleanup when eligible.

## Disposition values

| User choice | disposition |
|-------------|-------------|
| Merge locally into `base_branch` | `merged` |
| Push branch and create a PR | `pr_pending` |
| Keep branch unmerged for later | `kept` |
| Discard branch changes | `discarded` |

## Track branches in CONTEXT.md

```yaml
workflow_profile: balanced
task_branches:
  - task: 1
    branch: feature/oauth-refresh   # or feature/task-1-auth under strict
    disposition: merged
    deleted_at: 2026-07-27T12:00:00Z
execution_units:
  - id: auth-refresh
    branch: feature/oauth-refresh
    disposition: merged
```

Rules:
- **merged** or **discarded** → eligible for script cleanup
- **kept** or **pr_pending** → never delete
- Record `deleted_at` after successful cleanup

## Outcome memory

After disposition: load `outcome-memory`. Under `noteworthy-only`, skip routine SUCCESS with no review findings.

## Detect the base branch

1. CONTEXT `base_branch`
2. `origin/HEAD` symbolic-ref
3. `main` / `master` / `develop`

Never force-push to main/master.

## Plan-end finalization

- Optionally `reconcile` if drift suspected.
- LESSONS plan-level reflect when noteworthy.
- Cleanup remaining eligible branches via script:
  ```bash
  git checkout <base_branch>
  bash scripts/nexus-branch-cleanup.sh --base <base> --out .opencode/handoffs/plan-cleanup.json <branches...>
  ```
- Do **not** dispatch implementer for cleanup.

## Branch cleanup note

**Default: script cleanup** (`cleanupPolicy: script`). Orchestrator runs `scripts/nexus-branch-cleanup.sh` (merge-base ancestor checks). Raw `git branch -d` outside the script is discouraged; the script is the trusted path.

`branch-cleanup-prompt.md` is retained only as a fallback when the script cannot run (missing bash/git) — prefer fixing the environment over LLM deletion.
