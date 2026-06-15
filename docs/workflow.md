# OpenCode Nexus Workflow

OpenCode Nexus provides a structured multi-agent development workflow:

1. Orchestrator creates and manages a task plan.
2. Orchestrator confirms workflow preferences (`branch_policy`, `execution_mode`) and persists them in `.opencode/CONTEXT.md`.
3. Implementer writes code and tests for each task on a feature branch.
4. Spec Reviewer checks requirement fidelity.
5. Code Reviewer checks quality and risks.
6. Orchestrator pauses for checkpoint (or continues) based on `execution_mode`.
7. Orchestrator closes each task branch with an explicit user decision.
8. At plan completion, orchestrator dispatches implementer to batch-delete merged or discarded task branches.

## Workflow preferences

| Preference | Values | Default recommendation |
|------------|--------|------------------------|
| `branch_policy` | `isolated`, `stacked` | `isolated` — each task branches off `base_branch` |
| `execution_mode` | `checkpoint`, `continuous` | `checkpoint` — pause after each task for inspect/merge |

With **isolated** + **checkpoint**: merge task N into `base_branch` before starting task N+1. Never merge task N's branch into task N+1's branch.

## Isolation recovery

If a task branch inherits commits from a prior task (e.g. fast-forward merge), before reviews:

1. Merge the prior task into `base_branch`.
2. Rebase the current task branch onto `base_branch`.
3. Verify `git diff <base-branch>...<feature-branch>` shows only the current task's changes.

The workflow uses filesystem artifacts in `.opencode/` for durable coordination:

- `.opencode/plans/PLAN.md`
- `.opencode/CONTEXT.md`
- `.opencode/tasks/task-N.md`
- `.opencode/handoffs/task-N-<role>.json`
- `.opencode/handoffs/plan-cleanup-implementer.json`

This keeps execution resilient across long sessions and context compaction.

## Branch cleanup at plan completion

The orchestrator cannot delete branches (`git branch -d` / `-D` are denied). After all tasks pass review and finishing choices are recorded in `task_branches` (see `finishing-a-development-branch` skill):

1. Orchestrator checks out `base_branch`.
2. Orchestrator dispatches `implementer` with `branch-cleanup-prompt.md`.
3. Implementer deletes branches where disposition is `merged` or `discarded`.
4. Branches marked `kept` or `pr_pending` are never deleted.

## Orchestrator task permissions

The orchestrator agent denies all subagent dispatch by default (`"*": deny`) and then allows only `implementer`, `spec-reviewer`, and `code-reviewer`. Branch deletion (`git branch -d` / `-D`) is denied on the orchestrator and allowed on the implementer. OpenCode evaluates permission rules with **last matching rule wins**, so the wildcard must come first and specific `allow` entries after. Do not reorder these rules — see [OpenCode permissions docs](https://opencode.ai/docs/permissions/).
