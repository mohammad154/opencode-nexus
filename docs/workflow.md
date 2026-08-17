# Nexus V3 workflow

Nexus is a durable, profile-aware workflow for agent-assisted development. The orchestrator owns the run state and delegates implementation and review; deterministic scripts own repository analysis, call estimation, gates, and cleanup.

## Lifecycle

```text
request → classify → plan → graph → blast → implement → review → finish
                                      │
                                      └─ stale or blocked → reconcile
```

Durable state lives in `.opencode/runs/<run-id>/state.json`. Human context and handoffs live under `.opencode/`.

## Profiles

The default profile is `balanced`. Set `workflow_profile` in `.opencode/CONTEXT.md` or pass an explicit profile to the classifier.

| Profile | Branch policy | Implementer | Review |
|---|---|---|---|
| `fast` | Per feature/request | One per execution unit | Unified or skipped for documentation |
| `balanced` | Per feature/execution unit | One per execution unit | Risk-based |
| `strict` | Per task | One per task | Spec, then code |

Security, migration, public API, and credential work always uses `strict` plus dual review. HIGH blast always escalates **review** to dual; the execution profile is re-scored from Graphify callers and semantic impact, so batching may remain `balanced`. File/line counts are weak signals. UNKNOWN graph or blast evidence never classifies as `fast`. The direct path is narrow: it requires small, focused, low-risk evidence and high classifier confidence.

## Deterministic gates

Typical initialization and classification:

```bash
nexus project-init
nexus run init --run-id <id>
nexus classify \
  --files <count> --lines <count> --class <change-class> [--focused] [--docs]
nexus estimate --tasks <count> --profile <profile>
```

Typical engine gates:

```bash
nexus run transition --to CLASSIFIED --json '{"classification":{}}'
nexus run transition --to PLANNED --plan-skip
nexus run transition --to GRAPH_READY
nexus run transition --to BLAST_READY --blast <path-to-blast.json>
nexus run status
nexus run resume
```

The orchestrator must validate the implementer and reviewer handoffs before completing a run:

```bash
nexus run validate-handoff \
  --role implementer \
  --file .opencode/handoffs/<id>-implementer.json
jq -e '.verdict == "APPROVED"' .opencode/handoffs/<id>-unified-reviewer.json
```

Use the spec and code handoff checks instead of the unified check on strict or high-risk runs.

## Graph and blast

Graphify owns graph extraction/query/refresh. Nexus keeps the blast script and workflow gates; the optional compatibility agent should not be dispatched for deterministic work.

```bash
graphify extract . --code-only --directed --no-viz  # when graphify-out/graph.json is missing
graphify update .                                  # when it already exists
graphify query "<architecture question>"
graphify affected "<node-or-file>" --depth 2
nexus blast --files <file1,file2> --json
nexus blast --files <file1,file2> --task <id> --mermaid
```

Graphify records native freshness metadata and preserves directed node-link relations. Blast output records the detected risk and affected callers. Missing, malformed, stale, failed-refresh, or undirected evidence is UNKNOWN and must be fixed or verified before using a direct path.

## Agent roster and dispatch names

Canonical roles are:

```text
orchestrator
implementer
unified-reviewer
spec-reviewer
code-reviewer
reconciler
```

`blast-analyzer` remains an optional compatibility agent. Graphify is installed separately as an OpenCode prerequisite and is the sole graph provider.

OpenCode uses the bare canonical names (`orchestrator`, `implementer`, and the
other roster roles). Workflow policy and handoff schemas remain canonical.

## Execution units and review

Fast and balanced runs group related tasks into an execution unit. The unit records its shared files, acceptance criteria, review mode, blast artifact, and verification commands. One implementer handles the unit, then the appropriate reviewer handles the unit once.

Strict runs keep tasks isolated and use the sequence:

```text
implementer → spec-reviewer → code-reviewer → scripted cleanup
```

If a unified reviewer requests changes, rerun the implementer and unified review. If either dual reviewer requests changes, rerun the implementer and both review stages. Do not self-review when a reviewer is required.

## Artifacts

- `.opencode/CONTEXT.md` — active profile, branch, and verification context;
- `.opencode/plans/PLAN.md` — plan and acceptance criteria;
- `.opencode/tasks/` — tasks and execution units;
- `.opencode/handoffs/` — role results and review verdicts;
- `graphify-out/graph.json` — Graphify repository graph;
- `graphify-out/GRAPH_REPORT.md` — Graphify report;
- `.opencode/blast/` — Nexus blast reports;
- `.opencode/reconcile/` — Nexus reconcile reports; and
- `graphify-out/memory/` + `graphify-out/reflections/LESSONS.md` — Graphify outcome memory.

Run `nexus run status` after resuming a session. If a target, plan, graph, or handoff has drifted, stop and reconcile before implementation.

## Verification commands

The repository has no build, lint, or typecheck scripts. Use:

```bash
npm test
npm run test:install
bash scripts/test-install-only.sh
bash scripts/test-optional-agents.sh
bash scripts/test-adapter-contract.sh
bash -n install.sh uninstall.sh scripts/test-install-only.sh \
  scripts/test-optional-agents.sh scripts/test-adapter-contract.sh
```

The installer tests run OpenCode in an isolated temporary home and Git project, verify native agent names, verify optional-agent behavior, and assert that the source worktree remains unchanged.
