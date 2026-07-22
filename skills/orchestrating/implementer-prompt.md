# Implementer Dispatch Template (enhanced — blast + graph + LESSONS + drift)

Use this template when dispatching `implementer`. The orchestrator MUST include all bracket sections filled, plus blast report contents when available.

```text
You are implementing task: [TASK_ID] [TASK_TITLE]
> Effort: [XS|S|M|L|XL] | Confidence: [LOW|MEDIUM|HIGH] | Risk: [LOW|MEDIUM|HIGH]
> Plan commit: [short-sha] ([full-sha]) – drift check required before editing
> Branch policy: [isolated | stacked] | Execution mode: [checkpoint | continuous]

## STEP 0 — Required Reading (do this first, borrow no assumptions)
1. Read .opencode/tasks/task-N.md in full (contains STOP conditions, verification gates, blast radius, scope)
2. Read .opencode/CONTEXT.md (base_branch, branch_policy, verification_baseline, plan_commit)
3. Read .opencode/knowledge/graph.json excerpt (top importers / hub nodes) if present
4. Read .opencode/knowledge/blast/task-N.md if present (callers, Mermaid, risk level)
5. Read .opencode/knowledge/LESSONS.md recent entries if present (past failure modes to avoid)
6. Confirm you are on branch: [feature/task-N-slug]
   `git branch --show-current` must equal [feature/task-N-slug]

## STEP 0.5 — Drift check (from writing-plans / shadcn/improve pattern)
- Run: git rev-parse --short HEAD and compare to plan_commit [short-sha]
- Verify target file:line assumptions from task-N.md still hold:
  - Open each file:line in Evidence; if symbol missing, STOP
- Run baseline verification from CONTEXT.md verification_baseline (e.g. `npm test`) if first task or if baseline not yet recorded
- STOP conditions from task-N.md (if any true, return BLOCKED with evidence):
  - STOP if plan_commit drift > 50 commits or base_branch moved incompatibly
  - STOP if target file:line not found (drift)
  - STOP if baseline verification was already failing in that area
  - STOP if blast report grew from LOW to HIGH risk since plan written
  - [paste task-specific STOP conditions]

## Acceptance Criteria (from task-N.md – concise summary)
[Paste explicit acceptance criteria summary – MUST be checked off in handoff notes]
- [Pasted] Criterion 1
- [Pasted] Criterion 2

## Context

- Base branch: [base-branch]
- Feature branch: [feature/task-N-slug]
- Branch policy: [isolated | stacked] (from .opencode/CONTEXT.md)
- Handoff output path: .opencode/handoffs/task-N-implementer.json
- Graph path: .opencode/knowledge/graph.json (present: [yes/no], timestamp: [ts])
- Blast report: .opencode/knowledge/blast/task-N.md (risk: [LOW|MEDIUM|HIGH], callers: [N])
- LESSONS: .opencode/knowledge/LESSONS.md – [N] prior entries

### Blast radius (from nexus-blast.js – auto-generated)

[PASTE full blast markdown when present, or:]
- Risk: [LOW|MEDIUM|HIGH] score [N]
- Direct dependents: [list]
- Transitive callers (depth 2): [list]
- Mermaid: [paste diagram or link to blast/task-N.md]
- Implementer must ensure callers continue to work. If HIGH, add tests covering caller paths.

### Graph insight (from graph.json)

- Languages present: [from graph.md]
- Hub nodes near target: [list]
- External vs internal edges: [stats]

## Branch policy constraints (when isolated)

- Create the feature branch from base_branch only.
- Never merge, rebase, or cherry-pick from another task's feature branch.
- If prior task work is required on this branch, return BLOCKED and ask the orchestrator to merge the prior task into base_branch first.

## Instructions (implementation)

1. Re-read Acceptance Criteria and STOP – if anything ambiguous, return NEEDS_CONTEXT now (do not guess).
2. Implement ONLY this task (Scope In: [paste]; Out: [paste]). Do not edit Out files unless task explicitly requires and spec-reviewer approved blast scope.
3. Keep blast in mind:
   - If changing a function signature, check all callers listed in blast report; update or document required follow-up.
   - If HIGH risk, note in Notes for reviewer that callers were checked.
4. Add or update tests relevant to this task:
   - Follow exemplar pattern: [exemplar file from task-N.md]
   - Cover acceptance criteria + negative cases
   - If HIGH blast, add at least one integration/caller test.
5. Run verification gates exactly as listed in task-N.md:
   - [verification gate 1 – exact command]
   - [verification gate 2 – exact command]
   - `git diff [base]...feature/task-N-slug --stat` – ensure only expected files changed
6. Run blast verification: confirm callers from blast report still work (run their tests or manual check).
7. Commit changes on the assigned feature branch (never on base branch) with a clear message: "[task-N] <title>: <what>"
8. Write handoff JSON to .opencode/handoffs/task-N-implementer.json with:
   {
     "task_id": "task-N",
     "status": "DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT",
     "plan_commit": "[short-sha]",
     "commit": "<short-hash>",
     "branch": "feature/task-N-<slug>",
     "files_changed": ["<file>"],
     "tests": [{"command":"<cmd>","result":"pass|fail","evidence":"<output snippet>"}],
     "blast": {"risk":"LOW|MEDIUM|HIGH","verified":true,"callers_checked":["<file>"]},
     "verification_gates": [{"cmd":"<cmd>","expected":"<expected>","actual":"<actual>","pass":true}],
     "drift_check": {"plan_commit":"<sha>","current_head":"<sha>","pass":true},
     "notes_for_reviewer": ["<important note>"]
   }
9. Return status and summary (format below).

## Report Format (return this as your final message)

Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
Commit: <short-hash>
Branch: feature/task-N-<slug>
Plan commit drift: plan [sha] vs current [sha] – [ok|drift detected: reason]
Files Changed:
- <file> – <why, evidence>
Blast Radius:
- Risk: LOW|MEDIUM|HIGH (score N)
- Callers checked: [list]
- Mermaid: see .opencode/knowledge/blast/task-N.md
Tests:
- <command>: <result> (evidence snippet)
Verification Gates:
- <cmd>: expected <X>, got <Y> – [PASS|FAIL]
Notes for reviewer:
- <important note – blast, trade-offs, future risk>
STOP / BLOCKED reason (if applicable):
- <what triggered STOP, file:line evidence>
```
