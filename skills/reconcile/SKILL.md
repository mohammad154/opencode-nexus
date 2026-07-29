---
name: reconcile
description: Use to verify DONE tasks still hold, investigate BLOCKED tasks, refresh drifted plans, and retire findings fixed elsewhere — plan-end cleanup for drift and outcome coherence (inspired by shadcn/improve reconcile)
compatibility: opencode
---

# Reconcile

Ensures the PLAN is still a true picture of the repo after time and commits have passed. Equivalent to `improve reconcile` in the improve skill: verify DONE, investigate BLOCKED, refresh – retire dead findings, detect drift vs commit the plan was written for.

## When to run

- Before starting orchestration on a stale plan (commit drift suspected).
- After a checkpoint merge where base_branch moved.
- When implementer returned BLOCKED due to drift (STOP triggered).
- At plan end for final cleanup pass.
- On explicit user request: "reconcile the plan" or "check if plan still applies".
- Before finishing-a-development-branch at plan completion to catch stale todos.

## Pre-requisites

- .opencode/plans/PLAN.md must exist with plan_commit stamped.
- CONTEXT.md must have base_branch + plan_commit.
- graph.json may help for deeper checks (optional).

## Procedure

### Step 0 — Read state

1. Read `.opencode/plans/PLAN.md` – note plan_commit (short and full SHA from header), task list with [x]/[ ] marks, findings triage, verification_baseline.
2. Read `.opencode/CONTEXT.md` – plan_commit, base_branch, task_branches.
3. Read `.opencode/knowledge/graph.json` if present – freshness check.
4. Run:
   ```bash
   git rev-parse --short HEAD
   git rev-parse HEAD
   git merge-base --is-ancestor <plan_commit_full> HEAD && echo "plan is ancestor" || echo "plan commit not in history"
   git log --oneline <plan_commit_full>..HEAD | wc -l   # drift distance
   git diff --name-only <base_branch>...HEAD 2>/dev/null | head -n 50
   ```
5. For each task-N.md:
   - Check whether its Scope In files still contain Evidence file:line.
   - Check whether its verification_baseline still applicable.
   - Check handoff JSONs for status.

### Step 1 — Drift check (semantic primary, commit distance secondary)

Prefer the engine helper (does not invent approvals):

```bash
node scripts/nexus-run.js drift --json '{
  "plan_commit":"<sha>",
  "current_head":"<sha>",
  "commit_distance": <N>,
  "anchors":[{"file":"path","line":12,"text":"optional"}],
  "targets":[{"file":"path","signature":"Symbol.or.signature"}],
  "merge_base_changed": false
}'
```

Compare plan_commit vs current HEAD:

- If `git merge-base --is-ancestor <plan_commit> <base_branch>` fails → plan commit not ancestor of current base; base has been reset/rebased – STOP, warn user, recommend re-plan or explicit `reconcile --force` workflow.
- **Semantic HIGH** (blocks implement): broken file:line anchors, missing target symbols/signatures, incompatible merge-base, acceptance-criteria version mismatch.
- Commit distance alone: `<10` NONE/LOW, `10–50` LOW, `>50` → **MEDIUM** (secondary). Re-read PLAN.md assumptions; only escalate to HIGH if anchors/signatures fail.
- Do **not** treat 50 unrelated documentation commits as HIGH by themselves.

Record in CONTEXT.md:
```yaml
reconcile:
  at: <ISO timestamp>
  plan_commit: <short-sha>
  current_head: <short-sha>
  drift_commits: <N>
  drift_level: NONE|LOW|MEDIUM|HIGH   # from nexus-run.js drift (semantic)
  drift_reasons: []
  base_branch: <branch>
```

### Step 2 — Verify DONE tasks still hold

For each task marked [x] in PLAN.md:

1. Check the commit claimed in its handoff still in history: `git log --oneline --grep="<task-id>" | head -5` or check commit hash reachable.
2. Check its Scope In files still contain the feature described:
   - Re-read Evidence file:line – does current file still have the change?
   - Run its verification gates from task-N.md if cheap (no install needed; use existing test command + restricted scope, e.g. `npm test -- <file>`).
3. If task was merged to base_branch (task_branches disposition: merged), verify on base_branch (checkout base, run checks or file inspection, return to feature branch).
4. Result categories:
   - VERIFIED – still holds, evidence present, gates pass.
   - DRIFTED – evidence still present but surroundings changed; note but keep DONE.
   - REGRESSED – evidence gone or gate fails; mark TODO again or escalate to new task.
   - FIXED_ELSEWHERE – acceptance criteria met on base via different commit (e.g. user manually applied similar fix); retire as FIXED_ELSEWHERE.

Write outcome to `.opencode/knowledge/reconcile-<timestamp>.md` + update plan status if needed.

### Step 3 — Investigate BLOCKED / NEEDS_CONTEXT tasks

For each implementer handoff with status BLOCKED or NEEDS_CONTEXT:

1. Re-read blocker reason + file:line evidence.
2. Classify:
   - DRIFT_BLOCK – target symbol missing due to commits since plan written. Action: refresh task-N.md Evidence from current files, or rewrite task if scope changed.
   - ENV_BLOCK – missing dep, infra, permission. Action: guide user to fix env, then retry.
   - SCOPE_BLOCK – blast grew or hidden coupling discovered. Action: expand task Scope, or split task.
   - AUTH_BLOCK – needs decision / design clarity. Action: ask user.
3. Attempt auto-recovery for DRIFT_BLOCK when possible: re-detect target file:line via `rg -n <symbol> <dir>` and patch task-N.md Evidence.
4. If recovery fails, surface to user with concrete options:
   - Re-run writing-plans for this task only
   - Retire task if no longer needed
   - Split task

Write findings to reconcile report.

### Step 4 — Refresh remaining TODO tasks

For each remaining [ ] task:

1. Verify Evidence file:line – if broken and blast analysis now shows new callers, expand Scope In related callers section.
2. Re-run `node scripts/nexus-blast.js --files <scope in csv> --task N` to refresh blast report with current graph state.
3. If effort/confidence changed due to drift (e.g. file now larger, coupled), update task-N.md header (effort, risk).
4. If blast risk now HIGH and was LOW when planned, flag to user for explicit approval.

### Step 5 — Retire findings fixed elsewhere

1. If PLAN.md had Findings triage, check whether any finding's evidence file:line already fixed on current base:
   - E.g. finding about N+1 query at `src/users.ts:88` – does `users.ts:88` still contain the issue? Search via rg.
2. If fixed, mark as FIXED_ELSEWHERE in reconcile report and update PLAN.md triage table with note "fixed in <commit-sha>" – prevent executor from re-implementing.

### Step 6 — Update artifacts

- Update PLAN.md:
  - Add reconcile note at bottom: `> Reconciled <ISO timestamp>: drift N commits, DONE verified X, BLOCKED investigated Y, retired Z`
  - If tasks re-labeled, update checkboxes accordingly (do not remove tasks, only add notes).
- Update CONTEXT.md:
  - Set `reconcile` block as above + `last_reconcile: <timestamp>`
- Write `.opencode/knowledge/reconcile-<timestamp>.md` with full details:
  - Drift level + commit distance
  - Per-task verify/blocked findings
  - Retried evidence checks
  - Recommendations: "task-2 should be replanned – evidence broken" etc.

### Step 7 — Verdict for orchestrator

Return a concise summary for the orchestrator:

- Drift: NONE|LOW|MEDIUM|HIGH – <N> commits since plan
- DONE verified: X/Y still hold – <list of regressions if any>
- BLOCKED: <list with new classification + suggested action>
- TODO refreshed: blast re-run done, effort updates
- Retired: <findings now fixed elsewhere>
- Next action: proceed / re-plan / ask user

Hard rules:
- Never delete tasks – only mark or add notes.
- Never edit production code.
- Never auto-commit reconcile results – only edit .opencode/* artifacts.
- If drift HIGH and many DONE tasks REGRESSED, recommend re-running writing-plans or brainstorming rather than patching silently.
- When in doubt, conserve – mark DRIFTED rather than REGRESSED; let orchestrator or user decide.

### Reference: shadcn/improve reconcile contract borrowed

- Verify DONE plans still hold (machine-check gates)
- Investigate BLOCKED ones and rewrite around obstacle (drift recovery)
- Refresh drifted TODOs (blast refresh + evidence re-check)
- Retire findings fixed elsewhere (findings triage table update)
