# OpenCode Nexus Workflow

OpenCode Nexus provides a structured multi-agent development workflow with a knowledge graph, blast-radius safety, outcome memory, drift-resilient planning, and auto-reconciliation.

## V2 Overview diagram

```text
User request (plain language)
      │
      ▼
 brainstorming ──────────────────────────────────┐
      │                                          │
      ▼                                          │
 writing-plans (improve-grade)                     │  Skills auto-routed via using-nexus
   - Goal, Non-goals                              │
   - Context & Evidence (file:line exemplar)       │
   - Findings triage (effort/confidence)          │
   - Task N: effort/conf, evidence, STOP, gates   │  Outputs:
   - Execution order + dependency mermaid          │    .opencode/plans/PLAN.md  (plan_commit SHA stamped)
   - Verification strategy (global)               │    .opencode/tasks/task-N.md (improved template)
   - plan_commit: git rev-parse HEAD              │    .opencode/CONTEXT.md (verification_baseline)
      │                                          │
      ▼                                          │
 knowledge-graph ──► .opencode/knowledge/graph.json + graph.md + index.md
   - EXTRACTED/INFERRED edges                     │
   - God/hub nodes, language breakdown            │
   - jq recipes for agents                         │
      │                                          │
      ▼                                          │
 [workflow preferences gate]                       │
   branch_policy: isolated | stacked (isolated=rec)│
   execution_mode: checkpoint | continuous (check) │
      │                                          │
      ▼                                          │
Per task N (orchestrating loop):                  │
  ┌──────────────────────────────────────────┐  ─┘
  │ 1. blast-radius analysis                  │
  │      node scripts/nexus-blast.js --task N │
  │      → .opencode/knowledge/blast/task-N.md│
  │         Mermaid + risk LOW/MED/HIGH       │
  │ 2. Branch: feature/task-N-slug from base  │
  │ 3. Drift check: plan_commit vs HEAD       │
  │    (if >50 commits or file:line gone→    │
  │     STOP→reconcile)                       │
  │ 4. Implementer (graph+blast+LESSONS)      │
  │    - STOP handling                        │
  │    - Blast verification (callers checked) │
  │    - Gates: exact cmds                    │
  │    - Handoff: .opencode/handoffs/task-N-  │
  │      implementer.json (includes drift+   │
  │      blast+verification_gates)            │
  │ 5. Spec Reviewer                          │
  │    - file:line fidelity                   │
  │    - Blast scope fidelity                 │
  │    - Drift awareness                      │
  │    → APPROVED|REQUEST_CHANGES|            │
  │      ISOLATION_VIOLATION|BLOCKED(drift)   │
  │ 6. Code Reviewer                          │
  │    - Correctness, security, readability   │
  │    - Severity: HIGH|MED|LOW file:line     │
  │    - Blast regression: callers still work?│
  │    - LESSONS anti-pattern guard           │
  │ 7. Outcome memory: LESSONS.md entry       │
  │ 8. finishing-a-dev-branch:                │
  │    merge|PR|kept|discarded → disposition  │
  │    + LESSONS capture + reminder to        │
  │    "continue task N+1" (checkpoint)       │
  └──────────────────────────────────────────┘
      │ (repeat for each pending task)
      ▼
 reconcile (if needed or explicit)
   - Verify DONE tasks still hold (file:line)
   - Investigate BLOCKED (DRIFT/ENV/SCOPE/AUTH)
   - Refresh TODO blast reports (fresh graph)
   - Retire fixed-elsewhere findings (triaged table)
   → .opencode/knowledge/reconcile-*.md
      │
      ▼
 Plan completion
   - finishing-a-dev-branch (final disposition)
   - Build branches_to_delete from task_branches where disposition merged/discarded
   - Orchestrator checks out base_branch (never deletes itself)
   - Dispatch implementer via branch-cleanup-prompt.md
   - Handoff: plan-cleanup-implementer.json
   - Final LESSONS reflect (patterns + recommendations for next plan)
```

## Artifacts produced in .opencode/ (durable, compaction-surfaced)

- `.opencode/plans/PLAN.md` – improve-grade: header with plan_commit SHA (short+full) + ISO timestamp + detected verification baseline + drift warning; Goal, Non-goals; Context & Evidence with file:line + exemplar; Findings triage table (Impact/Effort/Confidence/Evidence); Task breakdown (effort/confidence/risk/depends/evidence in+out + blast callers + acceptance criteria + verification gates + STOP + implementation sketch); Execution order & dependency graph (+ Mermaid); Verification strategy (global); Rollback/safety; Outcome memory notes.
- `.opencode/CONTEXT.md` – active objective, current phase, base_branch (dynamic), branch_policy, execution_mode, verification_baseline (build/test/lint/typecheck cmds + outcome), plan_commit (short+full), generated_at, knowledge freshness (graph timestamp), reconcile block (at, current_head, drift_commits, drift_level, base_branch), pending blockers, next action, task_branches[] with disposition, cleanup_status.
- `.opencode/tasks/task-N.md` – enhanced template: slug, effort/confidence/risk/depends/plan_commit/base/branch/generated/graph/blast; Goal from PLAN; Context & Evidence file:line verified in this session + graph insight + past LESSONS excerpt; Scope In/Out + related callers (blast report pasted) + Mermaid ref; Acceptance criteria (machine-checkable + negative); STOP conditions (at least 2: target symbol + plan_commit drift + baseline fail + blast grow + task-specific); Verification gates (exact cmds + expected output); Implementation sketch; Handoff contract (JSON fields required).
- `.opencode/handoffs/task-N-<role>.json` – now with plan_commit, drift_check:{plan_commit,current_head,pass}, blast:{risk,verified,callers_checked[]}, verification_gates:[{cmd,expected,actual,pass}], findings[] with file:line, security notes.
- `.opencode/knowledge/` (new, V2):
  - `graph.json` – versioned, {version, root, generated_at, stats{total_files,nodes,edges,external_edges}, nodes[{id,label,path,lang,type,symbol_count,evidence,size_bytes,truncated}], edges[{from,to,relation,confidence:EXTRACTED|INFERRED,confidence_score,source_file,external}]}
  - `graph.md` – summary: Generated at + Root + Stats (files indexed, nodes, edges) + Languages breakdown + Hub nodes (highest out-degree) + How to use.
  - `index.md` – wiki entrypoint: Files list + Quick queries (jq recipes for importers/in-degree/out-degree/path-specific/languages/blast invocation) + Graph generation command + note for graph for long running + link to blast reports.
  - `blast/` – per-task blast-radius reports:
    - `task-N.md` – # Blast Radius – risk: **LEVEL** (score N); Changed files + downstream affected table (File|Depth|Via) + Mermaid flowchart TD (changed in red, dependents in yellow) + Implementer guidance (HIGH → split/expand, MEDIUM → tests for caller paths, LOW → isolated) + How graph built.
    - `task-N.json` – machine-readable {files, level, score, impacts[{file,depth,via,direct}], edges[{from,to,depth}]}
  - `LESSONS.md` – outcome memory (Graphify save-result/reflect pattern):
    - Each entry: timestamp + task-id + slug + OUTCOME (SUCCESS|SUCCESS_WITH_REWORK|BLOCKED_DRIFT|BLOCKED_ENV|DISCARDED) + branch, base, plan_commit, verifiers (build/test/lint ok/fail), blast risk/score/callers; Changed files file:line; Review notes (spec, code severity + fix, blast verification callers checked, missed callers discovered post-impl); Lesson (type=pattern|anti-pattern|gotcha|constraint|verification, applicable when condition, recommendation file:line); References (handoff JSONs + blast MD + diff command). Append-only, Summary section promoted when >200 lines.
  - `reconcile-<timestamp>.md` – reconcile report: drift level + commit distance + per-task verify/blocked findings + retired evidence checks + recommendations.
- `.opencode/handoffs/plan-cleanup-implementer.json` – branch cleanup handoff (deleted, skipped, failed).

This keeps execution resilient across long sessions and context compaction – plugin surfaces live CONTEXT + PLAN snapshot + knowledge graph MD + LESSONS tail + last reconcile in `experimental.session.compacting` hook.

## Workflow preferences

| Preference | Values | Default recommendation |
|------------|--------|------------------------|
| `branch_policy` | `isolated`, `stacked` | `isolated` — each task branches off `base_branch` |
| `execution_mode` | `checkpoint`, `continuous` | `checkpoint` — pause after each task for inspect/merge |
| `reconcile` block (new) | `{at, current_head, drift_commits, drift_level, base_branch}` | auto-populated |

With **isolated** + **checkpoint**: merge task N into `base_branch` before starting task N+1. Never merge task N's branch into task N+1's branch.

## Knowledge graph (new – lightweight Graphify-inspired)

- Built via `./scripts/nexus-graph.sh` (shell) or `node ./scripts/nexus-graph.js` (richer edges when node available). No pip, no tree-sitter, no embeddings – just shell + jq + optional node + rg/fd accelerators.
- EXTRACTED vs INFERRED tagging (borrowed from Graphify): explicit resolved imports are EXTRACTED confidence 1.0, unresolved/alias/external are INFERRED 0.75-0.9.
- Outputs live in `.opencode/knowledge/` (git-ignored-friendly). Drift creates new timestamp v2 – old entry discoverable via file mtime.
- Incremental update: run `nexus-graph.sh` again – deterministic given repo state, writes fresh graph (no --update merge yet; placeholder in index.md note for future).

## Blast radius (new – CodeLookup-inspired)

- From `nexus-blast.js`: git diff → changed files → BFS reverse dependency trace via graph.json reverse index (who imports changed file) → risk scoring → Mermaid `flowchart TD` → markdown + JSON artifacts under `.opencode/knowledge/blast/`.
- Shell fallback `nexus-blast.sh`: rg-based heuristics when node missing – `rg -l <basename>` for caller discovery.
- Orchestrator runs per task before implementer; risk HIGH flags to spec-reviewer for explicit scope approval.
- Spec-reviewer verifies blast scope fidelity (caller signatures updated?), code-reviewer verifies regression (callers still pass).

## Outcome memory (new – Graphify save-result/reflect-inspired)

- After each task's both reviewers APPROVED (or DISCARDED/BLOCKED), orchestrator dispatches write to `.opencode/knowledge/LESSONS.md` structured as above.
- Implementer prompt Required Reading includes LESSONS recent tail to avoid repeating.
- Spec-reviewer, code-reviewer also check LESSONS anti-patterns.
- At plan end, orchestrator does final reflect (what went well, surprise dependencies discovered via graph/blast, recommendations for next plan) – appended to LESSONS or separate plan-level entry.

## Drift handling (new – from shadcn/improve)

- PLAN.md and CONTEXT.md stamp git commit SHA it was written against (plan_commit full+short, generated_at ISO). Executors run `git rev-parse HEAD` comparison.
- If drift > 50 commits or target file:line missing, STOP → BLOCKED with evidence → orchestrator triggers `reconcile` skill or returns to user.
- Reconcile skill re-reads file:line evidence, classifies BLOCKED (DRIFT_BLOCK|ENV_BLOCK|SCOPE_BLOCK|AUTH_BLOCK), attempts auto-recovery via `rg -n <symbol>`, re-runs blast with fresh graph, retires findings fixed elsewhere.

## Isolation recovery

If a task branch inherits commits from a prior task (e.g. fast-forward merge), before reviews:

1. Merge the prior task into `base_branch`.
2. Rebase the current task branch onto `base_branch`.
3. Verify `git diff <base-branch>...<feature-branch>` shows only the current task's changes.

The workflow uses filesystem artifacts in `.opencode/` for durable coordination – see list above.

## Branch cleanup at plan completion

The orchestrator cannot delete branches (`git branch -d` / `-D` are denied). After all tasks pass review and finishing choices are recorded in `task_branches` (see `finishing-a-development-branch` skill):

1. Orchestrator checks out `base_branch`.
2. Orchestrator dispatches `implementer` with `branch-cleanup-prompt.md`.
3. Implementer deletes branches where disposition is `merged` or `discarded`.
4. Branches marked `kept` or `pr_pending` are never deleted.

## Orchestrator task permissions

The orchestrator agent denies all subagent dispatch by default (`"*": deny`) and then allows only named agents: `implementer`, `spec-reviewer`, `code-reviewer`, `blast-analyzer`, `knowledge-graph`, `reconciler`. Branch deletion (`git branch -d` / `-D`) is denied on orchestrator and allowed on implementer. OpenCode evaluates permission rules with **last matching rule wins**, so wildcard must come first and specific `allow` entries after. Do not reorder these rules — see [OpenCode permissions docs](https://opencode.ai/docs/permissions/).

## Multi-platform installer pattern (Graphify-inspired)

`install.sh` auto-detects installed agent platforms and drops appropriate artifacts:

- OpenCode: plugin entry merge via jq + agents under `~/.config/opencode/`
- Claude Code: `~/.claude/skills/nexus-*/` (one-level) + `~/.claude/agents/nexus-*.md`; optional `scripts/install-git-hook.sh` for post-commit graph refresh
- Cursor: `~/.cursor/rules/nexus-*.mdc` (`using-nexus` alwaysApply; others agent-requested)
- Codex: `~/.codex/skills/nexus-*/`
- Gemini CLI: `~/.gemini/skills/nexus-*/` + `~/.agents/skills/nexus-*/` (one-level; nested dirs are not discovered)
- Antigravity: `~/.gemini/config/skills/nexus-*/` + project `.agents/rules/nexus.md` + `.agents/workflows/nexus.md`

Same detection logic for `uninstall.sh`, with `--only platform` and `--all` filters (`--all` forces missing-binary installs; `--only` still filters).

## Verification gates (improve-grade)

Each task-N.md now must have verification gates with exact command + expected output, not prose. Implementer's handoff JSON must include verification_gates array with pass boolean – reviewer verifies claims.

## Global safety notes

- Graph build is read-only except `.opencode/knowledge/` writes.
- Graph build safe to run in parallel by multiple agents (last write wins, deterministic).
- Blast reports overwritten per task.
- LESSONS.md is git-ignored-friendly but persisted for session compaction surfacing.
- Reconcile never mutates production code – only `.opencode/*` artifacts.
