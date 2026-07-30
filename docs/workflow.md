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

Security, migration, public API, credential, and HIGH-blast work always escalates to dual review. The direct path is narrow: it requires small, focused, low-risk evidence and high classifier confidence.

## Deterministic gates

Typical initialization and classification:

```bash
node scripts/nexus-run.js init --run-id <id>
node scripts/nexus-classify.js \
  --files <count> --lines <count> --class <change-class> [--focused] [--docs]
node scripts/nexus-estimate-calls.js --tasks <count> --profile <profile>
```

Typical engine gates:

```bash
node scripts/nexus-run.js transition --to CLASSIFIED --json '{"classification":{}}'
node scripts/nexus-run.js transition --to PLANNED --plan-skip
node scripts/nexus-run.js transition --to GRAPH_READY
node scripts/nexus-run.js transition --to BLAST_READY --blast <path-to-blast.json>
node scripts/nexus-run.js status
node scripts/nexus-run.js resume
```

The orchestrator must validate the implementer and reviewer handoffs before completing a run:

```bash
node scripts/nexus-run.js validate-handoff \
  --role implementer \
  --file .opencode/handoffs/<id>-implementer.json
jq -e '.verdict == "APPROVED"' .opencode/handoffs/<id>-unified-reviewer.json
```

Use the spec and code handoff checks instead of the unified check on strict or high-risk runs.

## Graph and blast

Graph and blast are script-first operations. The compatibility agents are optional and should not be dispatched for deterministic work.

```bash
bash scripts/nexus-graph.sh
node scripts/nexus-blast.js --files <file1,file2> --json
node scripts/nexus-blast.js --files <file1,file2> --task <id> --mermaid
```

Graph generation uses its available cache metadata; refresh it when the repository changes or the extractor changes. Blast output records the detected risk and affected callers. Unknown or stale evidence must be verified before using a direct path.

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

`knowledge-graph` and `blast-analyzer` remain compatibility-only. They are installed only with `--with-optional-agents`; scripts are the default.

OpenCode uses the bare canonical names. Claude Code, Cursor, Codex, Gemini CLI, and Antigravity use the host-translated `nexus-<canonical-name>` names. The installer adapts only paths, frontmatter, prefixes, permission syntax, and dispatch names. Workflow policy and handoff schemas remain canonical.

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
- `.opencode/knowledge/graph.json` — repository graph;
- `.opencode/knowledge/blast/` — blast reports; and
- `.opencode/knowledge/LESSONS.md` — noteworthy outcomes.

Run `node scripts/nexus-run.js status` after resuming a session. If a target, plan, graph, or handoff has drifted, stop and reconcile before implementation.

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

The installer tests run each adapter in an isolated temporary home and Git project, verify prefixed outputs, verify optional-agent behavior, and assert that the source worktree remains unchanged.
