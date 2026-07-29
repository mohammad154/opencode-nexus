---
name: nexus-using-nexus
description: Use when starting any Nexus session - establishes automatic skill selection and workflow routing for orchestrator-driven development with graph, blast, and profile awareness
compatibility: opencode
---

# Using Nexus (V3 — executable workflow engine)

<SUBAGENT-STOP>
If you were dispatched as a subagent (implementer, spec-reviewer, code-reviewer, unified-reviewer, blast-analyzer, knowledge-graph, reconciler, or any nexus-* variant of those), skip this skill.
</SUBAGENT-STOP>

## The Rule

**Invoke the relevant Nexus skill BEFORE responding or acting** when the task is non-trivial.

For **narrowly gated direct-safe** work (docs/formatting/one-file internal with `direct_eligible` from the classifier), you may skip loading every skill — still run `node scripts/nexus-run.js classify` / `status` and verification.

For everything else: if a Nexus skill clearly applies, load it with OpenCode's `skill` tool and announce it.

Announce: "Using brainstorming to clarify requirements. (V3 engine: profiles + state machine + graph + blast + LESSONS)"

## Skill Router

| Situation | Skill to load |
|-----------|---------------|
| New feature, unclear scope, design questions | `brainstorming` |
| Requirements are clear, need a plan file | `writing-plans` |
| Need map of codebase / hubs | `knowledge-graph` skill docs; **run** `scripts/nexus-graph.sh` (do not dispatch optional agent) |
| Need safety check before editing | `blast-radius` skill docs; **run** `scripts/nexus-blast.js` |
| Plan exists, start or continue implementation | `orchestrating` (reads `profiles.md` + `dispatch.md`) |
| About to implement on a feature/task branch | `using-feature-branches` + blast script (skip blast only if `execution_mode: direct` and classifier `direct_eligible`) |
| Execution stuck / BLOCKED / plan stale | `reconcile` |
| All tasks reviewed and approved | `finishing-a-development-branch` + `outcome-memory` as needed |
| Reflect on past tasks / LESSONS | `outcome-memory` |
| Workflow complete / cleanup | `finishing-a-development-branch` + script cleanup |

## Workflow engine (required gates)

Durable machine state: `.opencode/runs/<run_id>/state.json`

```bash
node scripts/nexus-run.js init --run-id <id>
node scripts/nexus-classify.js --files N --lines N --class <class> [--focused] [--docs]
node scripts/nexus-run.js transition --to CLASSIFIED --json '{"classification":{...}}'
node scripts/nexus-run.js transition --to PLANNED --plan-skip   # or ensure PLAN.md exists
node scripts/nexus-run.js transition --to GRAPH_READY
node scripts/nexus-run.js transition --to BLAST_READY --blast <path.json>
node scripts/nexus-run.js transition --to IMPLEMENTING --branch <b> --acceptance 'c1|c2' ...
node scripts/nexus-run.js validate-handoff --role implementer --file .opencode/handoffs/<id>-implementer.json
node scripts/nexus-run.js status
node scripts/nexus-run.js resume
```

Exit code `3` = illegal transition → STOP / reconcile. Exit `2` = validation failure.

## Workflow profiles (V3)

Default: **`balanced`**. Config: `config/default-workflow.json`, `config/workflow-profiles.json`. Details: `orchestrating/profiles.md`.

Use the **scoring classifier** (`scripts/lib/classify.js` / `nexus-classify.js`) — do not interpret legacy `fastIf.or` as OR.

| Profile | When | Shape |
|---------|------|-------|
| `fast` | Low risk_score + tiny-internal/docs evidence | 1 implementer; unified or skip; 1 branch; scripts |
| `balanced` | Default / normal features | Batched units; risk-based review |
| `strict` | Hard triggers (security, migration, public API, HIGH blast) | Per-task + dual review |

Override: `--profile` or `workflow_profile` in CONTEXT.

Before multi-task runs: `node scripts/nexus-estimate-calls.js --tasks N --profile <p>`.

## Adaptive direct path (narrow)

Classifier may set `execution_mode: "direct"` only when **all** `direct_path` gates pass and `confidence >= 0.85`.

Flow: classify → deterministic checks → optional lightweight/none review → finish.

If Task/Agent **dispatch fails** AND classifier `direct_eligible` AND user did not set `execution_mode: delegated` → may use `DIRECT_IMPLEMENTING` with mandatory verification. Otherwise STOP and report (do not self-implement).

Exact CONTEXT line `execution_mode: direct` still authorizes orchestrator self-coding for that session.

## Skill order for new work

1. `brainstorming` (if unclear)
2. `writing-plans` (unless direct-safe docs)
3. `nexus-run.js init` + classify
4. Graph script (skip only for direct-eligible docs/formatting)
5. Blast script per unit/task (skip only when direct path)
6. Dispatch implementer (or direct path) → validate handoff → review per profile → script cleanup

## Branch cleanup

`scripts/nexus-branch-cleanup.sh` only. Never implementer branch delete.

## Subagent dispatch

Default roster: orchestrator, implementer, unified-reviewer, spec-reviewer, code-reviewer, reconciler.

Graph/blast **agents** are optional (`install.sh --with-optional-agents`); prefer scripts.

Full gates: `skills/orchestrating/dispatch.md`.

## Agent Selection

- Primary: **orchestrator** / `nexus-orchestrator`
- Scripts: `nexus-graph.sh`, `nexus-blast.js`, `nexus-branch-cleanup.sh`, `nexus-estimate-calls.js`, `nexus-run.js`, `nexus-classify.js`

## Context Preservation

- Machine state: `.opencode/runs/*/state.json`
- Human context: `.opencode/CONTEXT.md`, plans, tasks, handoffs, knowledge/
- Handoffs: prefer `schema_version: "1.0"` (legacy 0.9 migrates on validate)

## Red Flags

- "I'll just start coding" → classify + engine transitions + **dispatch implementer** (unless direct-eligible)
- Dispatch failed → STOP unless `direct_eligible`; never unrestricted self-coding
- Treating size-only change as `fast` without tiny-internal/docs evidence → use classifier
- Finishing without `nexus-run` / jq APPROVED gates when review required
- Dispatching LLM for graph/blast/cleanup/jq
