# Spec Reviewer Dispatch Template (enhanced — file:line fidelity + blast + drift)

Use this template when dispatching the **spec-reviewer** role on any platform.
Resolve the local agent name via `dispatch.md` (`spec-reviewer` on OpenCode; `nexus-spec-reviewer` on Claude/Cursor/AG; isolated reviewer turn on Codex/Gemini).
Always launch as a **fresh** subagent/turn after implementer handoff; do not self-review in the orchestrator.

```text
You are reviewing task: [TASK_ID] [TASK_TITLE]
> Plan commit: [short-sha] ([full-sha]) | Base: [base-branch] | Branch: [feature/task-N-slug]
> Effort: [XS|S|M|L] | Confidence: [LOW|MEDIUM|HIGH] | Blast risk: [LOW|MEDIUM|HIGH]

## Required Reading (do this first, in order)
1. Read .opencode/tasks/task-N.md – source of truth: acceptance criteria, STOP conditions, evidence, blast radius
2. Read .opencode/handoffs/task-N-implementer.json – what was claimed done, commit hash, blast verification, verification gates
3. Read .opencode/CONTEXT.md – base_branch, plan_commit
4. Read .opencode/blast/task-N.md – blast analysis, Mermaid diagram, downstream callers
5. Read graphify-out/reflections/LESSONS.md recent entries if present
6. Run: git diff [base-branch]...[feature/task-N-slug] – your sole scope (do not review unrelated history)

## Drift check (must verify before spec check)
- Compare plan_commit in task-N.md ([sha]) vs current feature branch HEAD and base_branch HEAD
- Verify each file:line in task-N.md Evidence still holds on base_branch…
- If drift detected (target file:line missing, blast report vs actual diff diverges, plan_commit > 50 commits old), note in verdict as potential ISOLATION_VIOLATION or DRIFT – escalate to orchestrator.

## Scope to Review
- Base branch: [base-branch]
- Feature branch: [feature/task-N-slug]
- Diff command: git diff [base-branch]...[feature/task-N-slug]
- Acceptance criteria: [paste summary from task-N.md – must be checked verbatim]
- STOP conditions from task-N.md: [paste]
- Blast scope: [paste callers list + Mermaid link]
  - If blast risk HIGH, require that related callers are explicitly handled or noted.

## Review Goal — file:line fidelity (from shadcn/improve vet step)

Check exact spec compliance, not vibes:
- Missing requirements: for each acceptance criterion, point to file:line where evidence exists or DOES NOT exist
- Incorrect behavior: does implementation match acceptance criteria logic?
- Out-of-scope additions: did implementer edit files listed in Out? Is blast exceeded without justification?
- Blast scope fidelity:
  - If task changed signature of function X, did it update all direct callers listed in blast report? Cite file:line for each caller check.
  - If HIGH risk and implementer did not update callers nor added tests for caller paths, REQUEST_CHANGES.

When `branch_policy: isolated`, run `git diff [base-branch]...[feature/task-N-slug]`. If changes from earlier unmerged tasks appear in the diff (compare to tasks/task-N.md scope + base), return:

VERDICT: ISOLATION_VIOLATION
- <describe contamination with file:line and required recovery: merge prior task to base_branch, rebase current branch>
- Cite CONTEXT.md task_branches + git log evidence

## Verification gates awareness

- Implementer claimed verification_gates results in handoff JSON – do they align with acceptance criteria? If gate says PASS but acceptance fails, flag.
- If implementer returned BLOCKED due to drift (STOP triggered), do NOT approve – escalate to orchestrator to run reconcile or re-plan.

## Output Format (must include file:line where applicable)

VERDICT: APPROVED
- [file:line] – acceptance criterion 1 verified at <location> via <method>
- [file:line] – criterion 2 verified
- Blast: [risk] – [N] callers reviewed, Mermaid in .opencode/blast/task-N.md
- Verification gates: align with claims, [N] pass

or

VERDICT: REQUEST_CHANGES
- [file:line | missing] – <specific missing acceptance criterion, expected location>
- [file:line] – <out-of-scope edit not in Scope In>
- [file:line] – <blast caller not handled: e.g. src/caller.ts:42 still uses old signature>
- [file:line] – <other fix with exact evidence>

or

VERDICT: BLOCKED (drift)
- <drift reason with sha / file:line evidence>
- Suggested action: reconcile or re-plan task-N

Also write review notes to .opencode/handoffs/task-N-spec-reviewer.json (schema 1.1):
{
  "schema_version": "1.1",
  "run_id": "[run_id]",
  "unit_or_task": "task-N",
  "agent": "spec-reviewer",
  "base_commit": "[pre-implementation commit]",
  "created_at": "[ISO timestamp]",
  "reviewed_commit": "[implementer commit]",
  "task_id": "task-N",
  "verdict": "APPROVED|REQUEST_CHANGES|ISOLATION_VIOLATION|BLOCKED",
  "plan_commit": "[sha]",
  "drift": {"detected": false, "reason": ""},
  "acceptance": [{"criterion":"<text>","pass":true,"evidence":"file:line"}],
  "blast": {"risk":"LOW|MEDIUM|HIGH","callers_reviewed":["<file>"],"pass":true},
  "findings": [{"file":"path","line":42,"issue":"<issue>"}]
}
```
