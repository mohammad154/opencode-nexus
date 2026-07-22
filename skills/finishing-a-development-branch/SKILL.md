---
name: finishing-a-development-branch
description: Use after tasks pass review to choose how to finalize the branch safely — with outcome memory (LESSONS) capture and reconcile awareness
compatibility: opencode
---

# Finishing a Development Branch (V2 – with outcome memory)

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
- Record branch disposition in `task_branches` (see below).
- **Outcome memory**: load `outcome-memory` skill – write entry to `.opencode/knowledge/LESSONS.md` capturing: what changed (file:line), blast level, what reviewers flagged, lesson for future tasks (type, applicable when, recommendation).
- Remind the user the orchestrator will wait for an explicit "continue task N+1" before the next task starts.

## All tasks complete

After all tasks are approved (or when the user requests final integration on the last task), present the same choices for the final branch if not already integrated.

1. Merge locally into `base_branch` (read from `.opencode/CONTEXT.md`; detect dynamically if unset — do not assume `main`).
2. Push branch and create a PR.
3. Keep branch unmerged for later.
4. Discard branch changes.

Map each user choice to a `disposition` value:

| User choice | disposition |
|-------------|-------------|
| Merge locally into `base_branch` | `merged` |
| Push branch and create a PR | `pr_pending` |
| Keep branch unmerged for later | `kept` |
| Discard branch changes | `discarded` |

## Track branch disposition in CONTEXT.md

After each per-task checkpoint or final integration choice, update `task_branches` in `.opencode/CONTEXT.md`:

```yaml
task_branches:
  - task: 1
    branch: feature/task-1-auth
    disposition: merged   # merged | discarded | kept | pr_pending
  - task: 2
    branch: feature/task-2-tests
    disposition: kept
```

Rules:
- **merged** or **discarded** → eligible for plan-end cleanup (implementer deletes the branch).
- **kept** or **pr_pending** → never delete in batch cleanup.
- Upsert the entry for the current task; do not remove entries for prior tasks.

## Outcome memory (new – V2 – after each disposition)

After disposition recorded:

1. Ensure `.opencode/knowledge/` exists – create if not.
2. Append entry to `.opencode/knowledge/LESSONS.md` via template from `outcome-memory` skill:
```markdown
### [YYYY-MM-DD HH:MM] task-N <slug> – <SUCCESS|SUCCESS_WITH_REWORK|DISCARDED|BLOCKED>
> branch: feature/task-N-<slug> | base: <base> | plan_commit: <sha>
> verifiers: build=[ok|fail] test=[ok|fail] lint=[ok|fail]
> blast: risk=[LOW|MEDIUM|HIGH] score=[N] callers=[N]

Changed:
- `path/file:line` – ...

Review notes:
- Spec: ...
- Code: [severity][file:line] ...
- Blast verification: callers checked [...]

Lesson:
- <one-paragraph, repo-specific lesson>
- Type: [pattern | anti-pattern | gotcha | constraint | verification]
- Applicable when: <condition>
- Recommendation: <actionable, file:line>

References:
- handoff: ...
- blast: .opencode/knowledge/blast/task-N.md
```

3. If LESSONS.md > 200 lines, consider promoting patterns: group entries by file prefix or type, add `## Summary (as of date)` at bottom with promoted patterns.

## Detect the base branch

Before merge or PR actions, resolve `base_branch`:

1. Read `base_branch` from `.opencode/CONTEXT.md` if set.
2. Else try: `git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'`
3. Else try local default: `main`, then `master`, then `develop`.
4. Record the chosen value in `.opencode/CONTEXT.md` as `base_branch`.

Rules:
- Never force-push to `main` or `master`.
- Confirm user intent before merge or discard actions.
- If creating a PR, include task summary and test evidence + blast summary when present.
- Update `.opencode/CONTEXT.md` with final state.
- In **continuous** mode (no per-task finishing UI), default disposition to `kept` unless the user explicitly requests merge or discard for a task.

## Plan-end finalization (after all tasks)

- Optionally run `reconcile` if drift suspected (plan_commit vs HEAD).
- Build final LESSONS summary:
  - What went well
  - Surprise dependencies discovered via graph/blast
  - Recommendations for next plan
- Present same choices for final branch if not already integrated.
- Then proceed to branch cleanup dispatch as described in orchestrating skill (orchestrator checks out base, dispatches implementer via branch-cleanup-prompt.md).

## Branch cleanup note

Branch deletion eligibility same as before. At plan end, finishing skill builds branches_to_delete from task_branches where disposition merged/discarded, but does NOT delete itself – delegates to orchestrator → implementer as before.
