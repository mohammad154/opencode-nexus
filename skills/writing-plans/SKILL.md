---
name: writing-plans
description: Use to create a concrete implementation plan with task breakdown and acceptance criteria in .opencode/plans/PLAN.md
compatibility: opencode
---

# Writing Plans

Create or update `.opencode/plans/PLAN.md` with:

- Goal statement
- Ordered tasks (`task-1`, `task-2`, ...)
- Acceptance criteria per task
- Target files and dependencies
- Verification steps

Also create or refresh `.opencode/CONTEXT.md` with:

- Active objective
- Current phase
- `base_branch` (detect dynamically — do not assume `main`)
- `branch_policy`: `isolated` | `stacked` (set during orchestration if not yet chosen)
- `execution_mode`: `checkpoint` | `continuous` (set during orchestration if not yet chosen)
- Pending blockers
- Next action

Planning rules:

- Keep tasks small and independently reviewable against `base_branch` when `branch_policy: isolated`.
- Prefer minimal diffs and existing patterns.
- Do not start implementation in this skill.
