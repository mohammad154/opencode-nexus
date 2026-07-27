---
name: outcome-memory
description: Use to record and retrieve task outcomes — save-result and reflect with noteworthy-only writes and path-filtered retrieval (LESSONS.md)
compatibility: opencode
---

# Outcome Memory — LESSONS.md (V3)

## Purpose

Prevent past mistakes from recurring. Inspired by Graphify save-result / reflect. File-only — no database.

## Where

- File: `.opencode/knowledge/LESSONS.md`
- Optional excerpt for agents: `.opencode/knowledge/LESSONS-excerpt.md` (top matching entries only)
- Schema per entry enforced — see template below

## lessonPolicy

Read from CONTEXT / profile (`config/workflow-profiles.json`):

| Policy | When to write |
|--------|----------------|
| `every-task` (strict default) | After each approved task/unit |
| `noteworthy-only` (fast/balanced default) | Only when criteria below match |

### Noteworthy-only write criteria

Write a LESSONS entry when **any** of:

- Review found a non-obvious issue (fix loop, MEDIUM/HIGH finding)
- Implementation failed or was BLOCKED
- A surprising dependency was discovered (blast/graph)
- An existing lesson prevented an error (cite which)
- User says "remember this"

Do **not** write permanent entries for routine SUCCESS with empty findings.

## Entry template

```markdown
### [YYYY-MM-DD HH:MM] task-N|unit-<id> <slug> – <OUTCOME>
> branch: <feature-branch> | base: <base> | plan_commit: <short-sha> | profile: <fast|balanced|strict>
> verifiers: build=[ok|fail] test=[ok|fail] lint=[ok|fail]
> blast: risk=[LOW|MEDIUM|HIGH] score=[N] callers=[N]
> tags: [subsystem, topic]

Changed:
- `path/file.ts:42` – what changed

Review notes:
- Reviewer: <what flagged or confirmed>
- Blast verification: <callers checked>

Lesson:
- <one-paragraph>
- Type: [pattern | anti-pattern | gotcha | constraint | verification]
- Applicable when: <retrieval condition — paths/symbols/risk>
- Recommendation: <actionable guidance>

References:
- handoff: .opencode/handoffs/...
- blast: .opencode/knowledge/blast/...

---
```

Outcomes: SUCCESS | SUCCESS_WITH_REWORK | BLOCKED_DRIFT | BLOCKED_ENV | DISCARDED

Keep ≤20 lines for Changed + Review notes + Lesson.

## When to read (reflect) — retrieval, not full dump

Prefer **top 3 matching** lessons by:

- Current file paths / Scope: In
- Subsystem tags
- Risk category (security, migration, etc.)

Write matches to `.opencode/knowledge/LESSONS-excerpt.md` for reference-first prompts.

Still allow full-file read for planning recon or explicit "what have we learned?"

## Reflect / compact

When LESSONS.md > ~200 lines: promote patterns under `# Patterns`; append `## Summary (as of date)`; never delete raw entries blindly.

## Hard rules

- Never delete past entries without user confirmation.
- Never record secrets.
- Append-only chronological entries.
- Respect `lessonPolicy` for the active profile.

## Integration

- orchestrating: writes per lessonPolicy after reviews
- implementer / reviewer prompts: read LESSONS-excerpt (or top matches), not necessarily entire LESSONS.md
- reconcile: match BLOCKED to known patterns
