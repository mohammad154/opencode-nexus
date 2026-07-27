# Implementer Dispatch Template (V3 — reference-first + batches)

Use when dispatching `implementer` for a single task (`strict`) or an execution unit (`fast`/`balanced`). Prefer **paths** over pasting large artifacts.

```text
You are implementing: [TASK_ID or EXECUTION_UNIT_ID] [TITLE]
> Profile: [fast|balanced|strict] | Effort: [...] | Blast risk: [LOW|MEDIUM|HIGH]
> Plan commit: [short-sha] – drift check required before editing
> Branch: [feature/...] | Base: [base] | Mode: [checkpoint|continuous]

## STEP 0 — Reference-first reading
1. Read: [path to task-N.md AND/OR execution-unit-<id>.json]
2. Read: .opencode/CONTEXT.md
3. Read blast: [path] (do not expect full paste)
4. Read LESSONS excerpt if present: .opencode/knowledge/LESSONS-excerpt.md (else top matching entries in LESSONS.md for Scope paths)
5. Confirm branch: `git branch --show-current` == [feature/...]

Optional compact payload (if present): .opencode/tasks/execution-unit-<id>.json
(goal, scope_in/out, acceptance_criteria, blast summary, verification)

## STEP 0.5 — Drift check
- git rev-parse --short HEAD vs plan_commit
- Verify Evidence file:line symbols still exist
- Honor STOP conditions in task/unit file → BLOCKED with evidence

## Acceptance criteria (concise)
- [criterion 1]
- [criterion 2]

## Scope
- In: [files or "see unit JSON"]
- Out: [files]

## Instructions
1. Implement ONLY listed task(s) in this dispatch. For batches: complete all tasks in the unit before handoff.
2. Respect blast callers; if HIGH risk, add caller-covering tests.
3. Run verification gates exactly (commands from task/unit file).
4. If you edit files outside declared scope: note it and recommend blast recompute.
5. Write handoff JSON to: .opencode/handoffs/[id]-implementer.json

## Handoff fields
status, commit, files_changed[], tests[], blast_verified, tasks_completed[] (batch), notes_for_reviewer, scope_extras[]

## Report
Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
...
```

For legacy single-task strict dispatches, `[id]` is `task-N`. For batches, `[id]` is the execution-unit id.
