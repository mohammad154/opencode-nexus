---
name: using-nexus
description: Use when starting any Nexus session - establishes automatic skill selection and workflow routing for orchestrator-driven development with graph and blast awareness
compatibility: opencode
---

# Using Nexus (V2 — cross-pollinated)

<SUBAGENT-STOP>
If you were dispatched as a subagent (implementer, spec-reviewer, code-reviewer, blast-analyzer, knowledge-graph, reconciler, or any nexus-* variant of those), skip this skill.
</SUBAGENT-STOP>

## The Rule

**Invoke the relevant Nexus skill BEFORE responding or acting.**

If there is even a 1% chance a Nexus skill applies, you MUST load it with OpenCode's `skill` tool. You do not need the user to name the skill.

Examples:
- User: "Add JWT auth" → load `brainstorming`, then `writing-plans` (improve-grade, with evidence), then `knowledge-graph`, then `orchestrating`
- User: "Continue task 2" → load `orchestrating` (auto triggers blast-radius for that task)
- User: "All tasks are done" → load `finishing-a-development-branch` + `reconcile` if drift suspected
- User: "What will break if I change X?" → load `blast-radius` (and `knowledge-graph` if graph missing)
- User: "Show me how the codebase is organized" → load `knowledge-graph`
- User: "Reconcile the plan" → load `reconcile`
- User: "What have we learned?" → load `outcome-memory`

Announce which skill you are using: "Using brainstorming to clarify requirements. (V2: graph + blast + LESSONS aware)"

## Skill Router

| Situation | Skill to load |
|-----------|---------------|
| New feature, unclear scope, design questions | `brainstorming` |
| Requirements are clear, need a plan file (improve-grade: file:line evidence, effort/confidence, STOP, drift SHA, verification gates) | `writing-plans` |
| Need map of codebase, dependency hubs, how to navigate | `knowledge-graph` |
| Need safety check before editing target files – what breaks? | `blast-radius` |
| Plan exists, start or continue implementation | `orchestrating` (internally triggers knowledge-graph + blast-radius) |
| About to implement on a task branch | `using-feature-branches` + `blast-radius` |
| Execution stuck / BLOCKED / plan stale / commit drifted | `reconcile` |
| All tasks reviewed and approved | `finishing-a-development-branch` (records branch disposition; writes LESSONS entry via `outcome-memory`) |
| Reflect on past tasks, read/write LESSONS.md, patterns | `outcome-memory` |
| Workflow complete, final verification + branch cleanup | `finishing-a-development-branch` + `reconcile` |

Skill order for new work (V2):

1. `brainstorming`
2. `writing-plans` (improve-grade – stamps commit, files:line, effort, STOP, blast placeholders)
3. `knowledge-graph` (build fresh graph so tasks cite real hub nodes + importers)
4. `using-feature-branches` (when execution starts)
5. Per task: `blast-radius` → implementer → **spec-reviewer** → **code-reviewer** → `outcome-memory` (LESSONS entry). Both reviewers are mandatory on every platform — see `orchestrating/dispatch.md`.
6. `finishing-a-development-branch` per checkpoint
7. At plan end: `reconcile` → `finishing-a-development-branch` (final) → plan-end cleanup (delete any remaining `feature/task-*` branches) → final LESSONS reflect

## Branch cleanup (default)

`branch_cleanup_policy: always` — delete merged/discarded `feature/task-*` branches when each task's work ends. Plan-end cleanup is a mandatory safety net. Branches marked `kept` or `pr_pending` are never deleted.

## Subagent dispatch (all platforms)

Canonical roles: `implementer` → `spec-reviewer` → `code-reviewer` (plus `blast-analyzer`, `knowledge-graph`, `reconciler` as needed).

**Resolve local name:** OpenCode uses the bare key (`@spec-reviewer`). Claude / Cursor / Antigravity install agents as `nexus-<key>` (e.g. `nexus-spec-reviewer`). Codex / Gemini ship skills only — still run both reviewer stages as isolated turns and write handoff JSON.

Full table + gates: `skills/orchestrating/dispatch.md` (installed as `nexus-orchestrating/dispatch.md` or inside the orchestrating rule).

**Two-stage review (required on every platform):** after implementer handoff → spec reviewer → wait APPROVED → code reviewer → wait APPROVED. Never skip; never parallel. Finish only when both `.opencode/handoffs/task-N-*-reviewer.json` files have `"verdict":"APPROVED"`.

Tool mapping notes:
- OpenCode: `Skill` tool; Task `@implementer` / `@spec-reviewer` / `@code-reviewer` / …
- Claude / Cursor / AG: Agent or Task with `nexus-*` names
- Codex / Gemini: load `nexus-orchestrating` skill; spawn subagents or isolated reviewer turns per `dispatch.md`
- `TodoWrite` → `todowrite` (OpenCode)

## Agent Selection

- Use **orchestrator** (or `nexus-orchestrator` where prefixed) as the primary agent for end-to-end workflow.
- Dispatch subagents only through orchestrator permissions when the platform enforces them.
- Blast / graph / reconcile: prefer named agents when installed; otherwise run `scripts/nexus-blast.js` / `scripts/nexus-graph.sh` / `reconcile` skill.

## Git requirement

This workflow requires a git repository for feature branches and review diffs.
If the project is not a git repo, ask the user to run `git init` (or open a git project) before orchestrating.

## New capability – dependency-light scripts

Two shell+node scripts now ship under `scripts/` (no Python, no pip):

- `nexus-graph.sh` + `nexus-graph.js` → `graph.json` with EXTRACTED/INFERRED edges + `graph.md` + `index.md` entrypoint
- `nexus-blast.sh` + `nexus-blast.js` → Mermaid blast radius + risk score + JSON

Agents should use shell commands if node unavailable. Prefers `rg`/`fd` if present, falls back to find/grep. Graph is git-ignored friendly (lives under `.opencode/knowledge/`).

## Context Preservation Rules

- Keep durable state in files, not only in chat context.
- Update `.opencode/CONTEXT.md` after each major state change (includes plan_commit, verification_baseline, reconcile block now).
- Write handoff JSON to `.opencode/handoffs/`.
- Dispatch subagents with full task text + acceptance criteria + blast report + LESSONS excerpt + drift SHA pasted into prompt.
- Graph + blast live under `.opencode/knowledge/` – survive context compaction (plugin surfaces them in `experimental.session.compacting` hook).
- Outcome memory grows under `.opencode/knowledge/LESSONS.md` – read on task dispatch, filtered by path.

## Red Flags

Stop and load a skill if you think:
- "The user didn't ask for a skill" → skills are automatic
- "I'll just start coding" → load `knowledge-graph` + `blast-radius` first, then `orchestrating` or `writing-plans`
- "This is a simple change" → still compute blast radius; simple changes in hub files can be HIGH risk
- "I need context on codebase" → load `knowledge-graph`, not fuzzy assumptions
- "Task is BLOCKED" → load `reconcile`, not silent retry
