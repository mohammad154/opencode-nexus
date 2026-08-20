# Implementer Dispatch Template (V4 — TDD + scope lock + impact)

Use when dispatching `implementer` for a single task. Prefer **paths** over pasting large artifacts. Fresh agent per task.

```text
You are implementing: [TASK_ID] [TITLE]
> Profile: [fast|balanced|strict] | Impact risk: [LOW|MEDIUM|HIGH|CRITICAL] | Confidence: [0–1]
> Plan commit: [short-sha] – drift check required before editing
> Branch/worktree: [path] | Allowed files: [list]
> Baseline: .opencode/runs/<id>/baseline.json

## STEP 0 — Reference-first reading
1. Read task file / acceptance criteria
2. Read impact report (risk, related tests, dependents)
3. Read baseline verification
4. Confirm scope lock — do NOT edit outside allowed_files (request expansion + re-impact instead)

## TDD (mandatory for behavioral changes / bug fixes)
1. Write failing test (RED) — record command + exit_code ≠ 0
2. Implement minimum fix
3. GREEN — same command exit_code 0
4. Run related/affected tests from impact report
5. Put tdd.red / tdd.green in handoff JSON

## Instructions
1. Implement ONLY this task in this dispatch
2. Run verification gates; do not claim pass without commands
3. Write handoff: .opencode/handoffs/[id]-implementer.json
```

## Handoff fields (schema_version 1.1 — required envelope)
Write JSON including ALL of:
- schema_version: "1.1"
- run_id, unit_or_task, agent: "implementer", base_commit (pre-implementation HEAD), created_at (ISO)
- status, commit (new implementation commit — must differ from base_commit when commits were made)
- files_changed[], tests[], tasks_completed[] (batch), notes_for_reviewer, scope_extras[]
- verification_gates: [{ id, cmd, pass: true }] — non-empty unless run verification_policy.exempt
- drift_check: { plan_commit, current_head, pass: true }
- blast: { risk, verified: true, artifact_digest? }

Do NOT set verification_exempt — exemptions come only from run state verification_policy.

## Report
Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
...
```

For legacy single-task strict dispatches, `[id]` is `task-N`. For batches, `[id]` is the execution-unit id.
