---
name: outcome-memory
description: Use to record and retrieve task outcomes — save-result and reflect pattern that lets reviewers learn from past tasks instead of starting cold every time (LESSONS.md). Trigger after each task's reviews pass or when orchestrator needs to carry forward prior anti-patterns
compatibility: opencode
---

# Outcome Memory — LESSONS.md (Graphify save-result / reflect pattern)

## Purpose

Prevent past mistakes from recurring across tasks and across plans. Every finished task writes a concise, searchable entry to `.opencode/knowledge/LESSONS.md`. Future tasks, spec-reviewers, and code-reviewers read it to avoid repeating failure modes. Inspired by Graphify's outcome memory pattern (`save-result` / `reflect` → `LESSONS.md`).

This is intentionally small and file-only — no database, no embeddings, no vector store.

## Where

- File: `.opencode/knowledge/LESSONS.md`
- Directory created automatically by nexus-graph.sh or first write
- Append-only per task, but periodic compaction summarized by reflect command
- Schema per entry is enforced — see template below

## When to write (save-result)

- After each task's spec-reviewer APPROVED + code-reviewer APPROVED (in orchestrating loop, right after reviews).
- After plan-end cleanup when final reconcile notes surprises.
- Manual: when user says "remember this" or review flagged a pattern worth capturing.

Responsible: **orchestrator**, after finishing-a-development-branch for that task (or via explicit load of this skill).

## Entry template (each entry is mandatory-structured)

```markdown
### [YYYY-MM-DD HH:MM] task-N <slug> – <OUTCOME>
> branch: feature/task-N-<slug> | base: <base> | plan_commit: <short-sha>
> verifiers: build=[ok|fail] test=[ok|fail] lint=[ok|fail] – command used
> blast: risk=[LOW|MEDIUM|HIGH] score=[N] callers=[N]

Changed:
- `path/file.ts:42` – what changed (one line)
- `path/other.ts:101` – what changed

Review notes:
- Spec reviewer: <what they flagged or confirmed>
- Code reviewer: <what they flagged – severity – fix>
- Blast verification: <caller paths checked, any missed callers discovered post-implementation>

Lesson:
- <one-paragraph lesson — what Future Tasks / reviewers should remember>
- Type: [pattern | anti-pattern | gotcha | constraint | verification]
- Applicable when: <condition for when this lesson applies to future tasks>
- Recommendation: <concrete actionable guidance, file:line level when possible>

References:
- handoff: .opencode/handoffs/task-N-implementer.json
- spec review: .opencode/handoffs/task-N-spec-reviewer.json
- code review: .opencode/handoffs/task-N-code-reviewer.json
- blast: .opencode/knowledge/blast/task-N.md (risk, mermaid)
- diff: git diff <base>...feature/task-N-<slug>

---
```

Outcome values:
- SUCCESS – shipped as planned, reviewers approved without rework
- SUCCESS_WITH_REWORK – needed N loops, but final APPROVED
- BLOCKED_DRIFT – blocked by drift, STOP triggered, required reconcile/re-plan
- BLOCKED_ENV – blocked by env / permissions / missing dependency
- DISCARDED – user chose discard at finishing step (record why)

Keep each entry concise: ≤20 lines for Changed + Review notes + Lesson combined. No log dumps. Point to handoff JSONs for raw evidence.

## When to read (reflect)

- At start of writing-plans: read full LESSONS.md to avoid planning anti-patterns.
- At start of each implementer dispatch (implementer-prompt.md required reading includes LESSONS).
- At start of spec-reviewer and code-reviewer dispatch – flag if current implementation repeats a known anti-pattern.
- In reconcile: when vetting BLOCKED tasks, check if BLOCKED matches a known pattern from prior run.
- On explicit user request: "what have we learned?" or "reflect".

## Reflect / compact

When LESSONS.md grows beyond ~200 lines:

1. Group entries by type and by file/path overlap
2. For each cluster with ≥3 entries on same area:
   - Promote to a "Pattern" note at top of file under `# Patterns` section
3. Do not delete raw entries; append a `## Summary (as of YYYY-MM-DD)` section at bottom:
   ```markdown
   ## Summary (as of YYYY-MM-DD) – promoted
   - Pattern: auth changes near `src/auth/*` tend to break sessions → always run integration test `npm test -- src/auth/session.test.ts`
   - Anti-pattern: changing `utils/format.ts` sign without grepping callers → HIGH blast, breaks 5+ files
   - Gotcha: sqlite tests flake on Node <18 due to better-sqlite3 dep
   ```

Guidance for LLM writing LESSONS entries:
- Use file:line evidence — not vibes
- Make lesson specific to this repo, not generic ("always use TypeScript" is generic, "validate session after auth refactoring at `src/auth/login.ts:42` via caller `src/middleware/session.ts:18`" is specific)
- "Applicable when" is your retrieval key — write it as a condition future dispatch prompt can match ("when task modifies any file in `src/api/routes/*`")

## Hard rules

- Never delete past entries without user confirmation (may be merged into patterns section but never dropped blindly).
- Never record secrets – file:line only for auth findings, not values.
- LESSONS.md lives under .opencode/knowledge/ and is git-ignored friendly (should already be inside opencode cache dir).
- Keep entries append-only and chronological so newest is at bottom (easiest for agents to read recent first if truncated).

## Example entries (from a hypothetical repo)

```markdown
# LESSONS.md – outcome memory for opencode-nexus workflows
> Generated by nexus outcome-memory skill pattern (Graphify save-result/reflect)
> Location: .opencode/knowledge/LESSONS.md – append-only, capped at summary when >200 lines

### [2026-03-10 14:02] task-1 auth-jwt – SUCCESS_WITH_REWORK
> branch: feature/task-1-auth-jwt | base: main | plan_commit: a1b2c3d
> verifiers: build=ok test=ok lint=ok
> blast: risk=MEDIUM score=8 callers=4

Changed:
- `src/auth/jwt.ts:12` – new JWT issuance helper
- `src/middleware/auth.ts:45` – integrated JWT verify into existing auth chain

Review notes:
- Spec reviewer: initially REQUEST_CHANGES – forgot refresh token flow `src/auth/jwt.ts:88`
- Code reviewer: [MEDIUM] `src/middleware/auth.ts:33` missing error boundary – fixed
- Blast verification: caller `src/api/routes/user.ts:18` checked, tests added `src/api/routes/user.test.ts:42`

Lesson:
- Auth changes look LOW blast but actually MEDIUM due to middleware chain importing jwt via barrel `src/auth/index.ts:5`
- Type: gotcha
- Applicable when: task touches `src/auth/*` or `src/middleware/auth*`
- Recommendation: run `npm test -- src/api/routes/*.test.ts` in addition to task's own tests – many callers import via barrel, not direct import.

References:
- handoff: .opencode/handoffs/task-1-implementer.json
- blast: .opencode/knowledge/blast/task-1.md

---
```

## Integration points in other skills

- writing-plans: references LESSONS.md in Recon step + copies applicable entries into each task's Graph insight section
- orchestrating: writes LESSONS entry after both reviews pass + plan-level reflect at plan end
- implementer-prompt.md and reviewer prompts: include LESSONS as Required Reading
- reconcile: when classifying BLOCKED, checks if it matches a known pattern
- nexus.js plugin compaction: appends recent LESSONS to session compaction context so long-running sessions don't lose failure memory
