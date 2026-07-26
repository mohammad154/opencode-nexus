# Code Reviewer Dispatch Template (enhanced — blast-aware + lessons + file:line)

Use this template when dispatching the **code-reviewer** role on any platform **after** spec review is APPROVED.
Resolve the local agent name via `dispatch.md` (`code-reviewer` on OpenCode; `nexus-code-reviewer` on Claude/Cursor/AG; isolated reviewer turn on Codex/Gemini).
Always launch as a **fresh** subagent/turn; never run in parallel with spec-reviewer.

```text
You are quality-reviewing task: [TASK_ID] [TASK_TITLE]
> Plan commit: [short-sha] | Base: [base-branch] | Branch: [feature/task-N-slug]
> Blast risk: [LOW|MEDIUM|HIGH] | Confidence: [LOW|MEDIUM|HIGH]

## Required Reading (do this first, in order)
1. Read .opencode/tasks/task-N.md – acceptance criteria, STOP, verification gates, blast context
2. Read .opencode/handoffs/task-N-implementer.json – implementation details, commit, blast_verified, verification_gates
3. Read .opencode/handoffs/task-N-spec-reviewer.json – spec verdict (must be APPROVED), acceptance evidence, blast_review
4. Read .opencode/CONTEXT.md – base_branch, plan_commit
5. Read .opencode/knowledge/blast/task-N.md – blast diagram + callers, to assess regression risk
6. Read .opencode/knowledge/LESSONS.md recent entries – avoid repeating past anti-patterns, flag if code repeats one
7. Diff: git diff [base-branch]...[feature/task-N-slug] – your exact review scope

## Inputs
- Base branch: [base-branch]
- Feature branch: [feature/task-N-slug]
- Diff command: git diff [base-branch]...[feature/task-N-slug]
- Spec review result: APPROVED (from handoff) – with file:line evidence for each criterion
- Blast report: .opencode/knowledge/blast/task-N.md – risk [LOW|MEDIUM|HIGH], [N] affected files, Mermaid diagram
- Verification gates claimed by implementer: [paste list]

## Review Goal — correctness, security, maintainability with blast awareness

- Correctness and edge cases:
  - Does task diff correctly handle happy path + error path?
  - Are STOP conditions from task file honored (drift detection, blast caller handling)?
- Security issues:
  - Injection, secrets, permission escalations, unsafe deserialization
  - If plan mentions auth/boundary code, verify minimum privilege
- Maintainability and readability:
  - Matches exemplar pattern cited in task-N.md Evidence?
  - Naming, modularity, comment for non-obvious code
- Test adequacy:
  - Do tests cover acceptance criteria file:line?
  - If blast risk MEDIUM/HIGH, are caller paths tested? If not, REQUEST_CHANGES.
  - Does verification_gates claim align with actual test output? Run `git diff <base>...<branch> -- <new test file>` to verify new tests exist.

When `branch_policy: isolated`, run `git diff [base-branch]...[feature/task-N-slug]`. If changes from earlier unmerged tasks appear in the diff, return:

VERDICT: ISOLATION_VIOLATION
- <describe contamination with file:line and required recovery: merge prior task to base_branch, rebase current branch>
- Cite git log evidence: `git log base..HEAD -- <file>`

## Blast-aware heuristics (from CodeLookup)

- Signature change with HIGH blast:
  - Every direct caller listed in blast must be updated or tested for backwards compat
  - If not, REQUEST_CHANGES citing unhandled caller file:line
- Shared-state change (config, global, env, singleton):
  - Assume HIGH blast regardless of import graph – recommend integration tests
- Deletion:
  - Verify deleted symbol no longer imported anywhere (rg -l <symbol>). If still imported, BLOCK

## LESSONS awareness (from Graphify outcome memory)

- Check if this task's implementation repeats a pattern flagged in LESSONS.md
- If yes, note in verdict and request change to prefer the recommended pattern from LESSONS entry

## Output Format – file:line for each finding

VERDICT: APPROVED
- [file:line] – happy path correct, matches exemplar at <exemplar:line>
- [file:line] – error handling ok (tested at <test-file:line>)
- Blast [risk] – callers checked: <list> – no regressions observed, Mermaid in blast/task-N.md
- Security: none
- Verification gates: claims match expected (N passed)
- LESSONS: checked – no anti-pattern repetition

or

VERDICT: REQUEST_CHANGES
- [HIGH][file:line] – <correctness/security issue, required fix with exact file:line>
- [MEDIUM][file:line] – <blast: caller src/caller.ts:42 not updated after signature change in src/target.ts:20>
- [LOW][file:line] – <maintainability / naming / test gap>
- ...

or

VERDICT: BLOCKED (drift / blast surprise)
- <reason: e.g. new transitive caller discovered not in original blast, target file drifted, symbol missing>
- Action: re-run `node scripts/nexus-blast.js --depth 3` or reconcile

Prioritize findings by severity: HIGH = must fix before merge, MEDIUM = should fix (callers broken), LOW = nit (optional but logged)

Also write review notes to .opencode/handoffs/task-N-code-reviewer.json:
{
  "task_id": "task-N",
  "verdict": "APPROVED|REQUEST_CHANGES|ISOLATION_VIOLATION|BLOCKED",
  "plan_commit": "[sha]",
  "findings": [{"severity":"HIGH|MEDIUM|LOW","file":"path","line":42,"issue":"<issue>","fix":"<required fix>"}],
  "blast": {"risk":"LOW|MEDIUM|HIGH","callers_checked":["<file>"],"regression_risk":"low|medium|high"},
  "security": {"issues":0,"notes":""},
  "verification_gates_verified": true,
  "lessons_checked": true
}
```
