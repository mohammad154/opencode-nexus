---
name: using-nexus
description: Use when starting any Nexus session - establishes automatic skill selection and workflow routing for orchestrator-driven development with graph, blast, and profile awareness
compatibility: opencode
---

# Using Nexus (V3 — profiles + scripts-first)

<SUBAGENT-STOP>
If you were dispatched as a subagent (implementer, spec-reviewer, code-reviewer, unified-reviewer, blast-analyzer, knowledge-graph, reconciler, or any nexus-* variant of those), skip this skill.
</SUBAGENT-STOP>

## The Rule

**Invoke the relevant Nexus skill BEFORE responding or acting.**

If there is even a 1% chance a Nexus skill applies, you MUST load it with OpenCode's `skill` tool. You do not need the user to name the skill.

Announce which skill you are using: "Using brainstorming to clarify requirements. (V3: profiles + graph + blast + LESSONS aware)"

## Skill Router

| Situation | Skill to load |
|-----------|---------------|
| New feature, unclear scope, design questions | `brainstorming` |
| Requirements are clear, need a plan file | `writing-plans` |
| Need map of codebase / hubs | `knowledge-graph` (prefer `scripts/nexus-graph.sh`) |
| Need safety check before editing | `blast-radius` (prefer `scripts/nexus-blast.js`) |
| Plan exists, start or continue implementation | `orchestrating` (reads `profiles.md`) |
| About to implement on a feature/task branch | `using-feature-branches` + `blast-radius` |
| Execution stuck / BLOCKED / plan stale | `reconcile` |
| All tasks reviewed and approved | `finishing-a-development-branch` + `outcome-memory` as needed |
| Reflect on past tasks / LESSONS | `outcome-memory` |
| Workflow complete / cleanup | `finishing-a-development-branch` + script cleanup |

## Workflow profiles (V3)

Default: **`balanced`**. Config: `config/default-workflow.json`, `config/workflow-profiles.json`. Details: `orchestrating/profiles.md`.

| Profile | When | Shape |
|---------|------|-------|
| `fast` | Tiny / docs / low-risk | 1 implementer per request; unified or skip review; 1 branch; scripts |
| `balanced` | Normal features | Batched execution units; risk-based review; per-feature branch |
| `strict` | Security, migrations, public API, HIGH blast, or explicit | Per-task branch + dual review (legacy) |

Override: user says `--profile fast|balanced|strict` or sets `workflow_profile` in CONTEXT.

Before multi-task runs: `node scripts/nexus-estimate-cost.js --tasks N --profile <p>`.

## Skill order for new work (V3)

1. `brainstorming`
2. `writing-plans`
3. Graph via **script** (cache-by-commit): `bash scripts/nexus-graph.sh`
4. Classify / set `workflow_profile` (+ cost estimate)
5. `using-feature-branches` when execution starts
6. Per execution unit (or per task if strict): blast script → implementer → review per profile → outcome-memory (policy-aware) → finishing → **script** branch cleanup
7. Plan end: `reconcile` if needed → finishing → `scripts/nexus-branch-cleanup.sh` for any remaining branches → LESSONS reflect if noteworthy

## Branch cleanup (default)

`cleanupPolicy: script` — run `scripts/nexus-branch-cleanup.sh` (ancestor checks). Do **not** dispatch implementer solely to delete branches. `kept` / `pr_pending` never deleted.

## Subagent dispatch

Canonical roles: `implementer` → (`unified-reviewer` **or** `spec-reviewer` → `code-reviewer`) plus optional blast/graph/reconciler.

**Prefer scripts** for graph, blast, cleanup, cost estimate. Blast/graph **agents** are optional.

Full gates: `skills/orchestrating/dispatch.md`.

## Agent Selection

- Primary: **orchestrator** / `nexus-orchestrator`
- Scripts: `scripts/nexus-graph.sh`, `scripts/nexus-blast.js`, `scripts/nexus-branch-cleanup.sh`, `scripts/nexus-estimate-cost.js`

## Git requirement

Requires a git repository for feature branches and review diffs.

## Context Preservation

- Durable state in `.opencode/CONTEXT.md`, plans, tasks, handoffs, knowledge/
- Execution units: `.opencode/tasks/execution-unit-<id>.json`
- Reference-first subagent prompts (paths over pasted blobs)
- LESSONS: retrieve top matching; write noteworthy-only under fast/balanced

## Red Flags

- "I'll just start coding" → graph script + blast + profile + orchestrating/writing-plans → **dispatch implementer** (do not code in the orchestrator turn)
- Pasted "complete implementation plan" / "please implement" → still **dispatch implementer**; only exact `execution_mode: direct` in CONTEXT allows orchestrator self-coding
- Implementer Task/Agent call failed → STOP and report; never fall back to orchestrator implementing
- "This is simple" → still blast; hub files can be HIGH → escalate to strict review
- "Task is BLOCKED" → reconcile
- Dispatching an LLM to run `jq` / delete a branch / rebuild an unchanged graph → use scripts
