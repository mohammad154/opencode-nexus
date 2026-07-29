# OpenCode Nexus Workflow

OpenCode Nexus provides a structured multi-agent development workflow with a knowledge graph, blast-radius safety, outcome memory, drift-resilient planning, auto-reconciliation, **V3 workflow profiles** (`fast` / `balanced` / `strict`), and an **executable workflow engine** (`scripts/nexus-run.js`) that validates transitions and handoffs.

## V3 profiles (default: balanced)

See [`skills/orchestrating/profiles.md`](../skills/orchestrating/profiles.md) and [`config/workflow-profiles.json`](../config/workflow-profiles.json).

Classification uses a **scoring model** (`node scripts/nexus-classify.js`) — not the deprecated ambiguous `fastIf.or` shape.

| Profile | Branch | Implementer | Review | Graph / blast | LESSONS | Cleanup |
|---------|--------|-------------|--------|---------------|---------|---------|
| `fast` | per feature/request | 1 per unit | unified or skip | script + cache | noteworthy-only | `nexus-branch-cleanup.sh` |
| `balanced` | per feature / execution unit | 1 per unit | risk-based | script + cache | noteworthy-only | script |
| `strict` | per task | 1 per task | dual always | script (rebuild on resume) | every task | script |

```text
User request
    │
    ▼
 nexus-run init → classify (score) → transitions (GRAPH/BLAST/…)
    │
    ├─ direct (narrow) → verify → (none review) → complete
    ├─ fast      → implementer → (unified|skip) → script cleanup
    ├─ balanced  → batch unit → implementer → risk review → script cleanup
    └─ strict    → per-task blast → implementer → spec → code → script cleanup
```

Call estimate (agent calls, not USD):

```bash
node scripts/nexus-estimate-calls.js --tasks 5 --profile balanced
```

Engine gates:

```bash
node scripts/nexus-run.js init --run-id <id>
node scripts/nexus-run.js transition --to CLASSIFIED --json '...'
node scripts/nexus-run.js validate-handoff --role implementer --file .opencode/handoffs/<id>-implementer.json
node scripts/nexus-run.js status
```

## Overview diagram

```text
User request (plain language)
      │
      ▼
 brainstorming → writing-plans → knowledge-graph (script, cache-by-commit)
      │
      ▼
 [workflow preferences + profile gate]
   workflow_profile: fast | balanced | strict (default balanced)
   branch_policy: per-feature | isolated | stacked
   execution_mode: checkpoint | continuous
      │
      ▼
Execution unit OR per-task loop (see profile):
  1. blast script (unit or task)
  2. feature branch
  3. drift check
  4. implementer (reference-first prompts)
  5. review: unified | dual | skip (matrix)
  6. LESSONS per lessonPolicy
  7. finishing + scripts/nexus-branch-cleanup.sh
      │
      ▼
 reconcile (if needed) → plan-end script cleanup → LESSONS reflect if noteworthy
```

## Artifacts produced in .opencode/

- `.opencode/plans/PLAN.md` – improve-grade plan with plan_commit SHA
- `.opencode/CONTEXT.md` – includes `workflow_profile`, policies, plan_commit, task_branches, execution_units, cleanup_status
- `.opencode/tasks/task-N.md` – enhanced task template
- `.opencode/tasks/execution-unit-<id>.json` – batched unit payload (fast/balanced)
- `.opencode/handoffs/<id>-<role>.json` – implementer / unified / spec / code / cleanup
- `.opencode/knowledge/` :
  - `graph.json` – includes `generated_at_commit`, `generator_version` for cache
  - `graph.md`, `index.md`
  - `blast/<id>.md` + `.json`
  - `LESSONS.md`, optional `LESSONS-excerpt.md`
  - `reconcile-*.md`

## Workflow preferences

| Preference | Values | Default recommendation |
|------------|--------|------------------------|
| `workflow_profile` | `fast`, `balanced`, `strict` | **`balanced`** |
| `branch_policy` | `per-feature`, `isolated`, `stacked` | `per-feature` (balanced/fast); `isolated` (strict) |
| `execution_mode` | `checkpoint`, `continuous` | `continuous` (balanced/fast); `checkpoint` (strict) |
| `lessonPolicy` | `noteworthy-only`, `every-task` | from profile |
| `cleanupPolicy` | `script` | always script |

## Knowledge graph

- `./scripts/nexus-graph.sh` — **cache-by-commit**: skips rebuild when `generated_at_commit` == HEAD and `generator_version` matches (unless dirty non-doc files). Use `--force` to rebuild. `--docs-only-skip` keeps existing graph for docs-only work.
- Prefer script over knowledge-graph agent.

## Blast radius

- `node scripts/nexus-blast.js --files <csv> --task <id> --mermaid`
- Per execution unit (fast/balanced) or per task (strict). Prefer script over blast-analyzer agent.

## Outcome memory

- `noteworthy-only` (fast/balanced): write when review findings / BLOCKED / surprises / user asks.
- `every-task` (strict): write after each approval.
- Retrieve top matching lessons into `LESSONS-excerpt.md` for subagents.

## Branch cleanup

**Script-first:** `bash scripts/nexus-branch-cleanup.sh --base <base> --out <json> <branches...>`

Orchestrator may run this script; raw `git branch -d` remains denied. Do not dispatch implementer solely to delete branches.

## Review gates

See [`skills/orchestrating/dispatch.md`](../skills/orchestrating/dispatch.md).

- Dual: spec then code (strict / high-risk)
- Unified: `unified-reviewer` (fast/balanced low–medium)
- Skip: docs-only under fast when matrix allows

Orchestrator allows: implementer, spec-reviewer, code-reviewer, **unified-reviewer**, blast-analyzer, knowledge-graph, reconciler.

## Multi-platform installer

`install.sh` installs agents including `unified-reviewer` and skills with `profiles.md`.

## Global safety notes

- Prefer scripts for deterministic ops.
- Graph cache is safe; `--force` when generator bumps.
- LESSONS append-only; respect lessonPolicy.
- Reconcile never mutates production code.
