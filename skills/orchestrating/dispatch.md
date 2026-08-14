# Subagent Dispatch (OpenCode) — V3 profiles

Canonical roles:

| Role            | Canonical key       | When                                      |
| --------------- | ------------------- | ----------------------------------------- |
| Implementer     | `implementer`       | After blast + branch ready                |
| Spec reviewer   | `spec-reviewer`     | Dual-review path after implementer DONE\* |
| Code reviewer   | `code-reviewer`     | After spec verdict APPROVED               |
| Unified reviewer| `unified-reviewer`  | Fast/balanced risk-based unified review   |
| Blast analyzer  | `blast-analyzer`    | Optional; **prefer scripts**              |
| Graphify graph | `graphify query` / `graphify affected` | External prerequisite; sole graph provider |
| Reconciler      | `reconciler`        | On BLOCKED / drift                        |

Deterministic ops (do **not** dispatch an agent):

| Op        | Command |
|-----------|---------|
| Run / gates | `node scripts/nexus-run.js <init\|classify\|transition\|validate-handoff\|status\|resume\|drift>` |
| Classify  | `node scripts/nexus-classify.js --files N --lines N --class <c>` |
| Graph     | `graphify extract . --code-only --directed --no-viz` when missing; `graphify update .` otherwise |
| Blast     | `node scripts/nexus-blast.js --files ...` (JSON default; `--mermaid` or HIGH risk for diagrams; `--task <id>` persists) |
| Cleanup   | `bash scripts/nexus-branch-cleanup.sh --base <base> --out <json> <branches...>` |
| Call est. | `node scripts/nexus-estimate-calls.js --tasks N --profile <p>` (shim: `nexus-estimate-cost.js`) |
| Gates     | `node scripts/nexus-run.js validate-handoff --role <role> --file ...` then `jq -e '...'` |

The optional `blast-analyzer` agent is **not** in the default install. Prefer Graphify and Nexus scripts. Use `install.sh --with-optional-agents` only for compatibility.

## Resolve the local agent name

Dispatch with the canonical key as installed under `~/.config/opencode/agents/`.
OpenCode uses the bare name (`@spec-reviewer`, Task tool, or the matching agent
file). Never invent a prefixed `nexus-*` alias.

## Review gates by profile

Read `workflow_profile` + change class from CONTEXT / execution-unit JSON. See [`profiles.md`](profiles.md).

### Dual review (strict, or high-risk under any profile)

After implementer returns `DONE` or `DONE_WITH_CONCERNS`:

1. **Do not** review in the orchestrator turn.
2. Dispatch **spec-reviewer** → wait `"verdict": "APPROVED"`.
3. Dispatch **code-reviewer** → wait `"verdict": "APPROVED"`.
4. Then outcome-memory (per lessonPolicy) → mark done → finishing/merge → script cleanup.

```bash
jq -e '.status=="DONE" or .status=="DONE_WITH_CONCERNS"' .opencode/handoffs/<id>-implementer.json
jq -e '.verdict=="APPROVED"' .opencode/handoffs/<id>-spec-reviewer.json
jq -e '.verdict=="APPROVED"' .opencode/handoffs/<id>-code-reviewer.json
```

### Unified review (fast/balanced, low–medium risk)

1. Dispatch **unified-reviewer** with `unified-reviewer-prompt.md`.
2. Wait `.opencode/handoffs/<id>-unified-reviewer.json` `"verdict": "APPROVED"`.
3. If handoff sets `escalate_to_dual: true` → run dual path instead.

```bash
jq -e '.verdict=="APPROVED"' .opencode/handoffs/<id>-unified-reviewer.json
```

### Skip review (documentation-only under fast)

1. Implementer DONE + verification gates green.
2. No reviewer dispatch. Record `review: skipped` in CONTEXT.

### Fix loops

- Spec `REQUEST_CHANGES` → implementer → re-run spec (then code). Max 3 loops.
- Code `REQUEST_CHANGES` → implementer → re-run **both** dual stages. Max 3 loops.
- Unified `REQUEST_CHANGES` → implementer → re-run unified (or dual if escalated). Max 3 loops.

## Anti-patterns

- Using dual review when profile+matrix say skip/unified **without** high-risk trigger
- Skipping required dual review for security / migration / public-api / HIGH blast
- Parallel spec + code review when dual is required
- Self-review inside orchestrator/implementer when a reviewer is required
- **Orchestrator writing production code** instead of dispatching implementer — exceptions only:
  - CONTEXT has exact `execution_mode: direct`, **or**
  - classifier `direct_eligible: true` **and** dispatch unavailable **and** user did not set `execution_mode: delegated`
- Treating a pasted plan / “please implement” / “start coding” as permission to self-implement
- Falling back to self-coding when Task/Agent dispatch fails **unless** the narrow direct-eligible exception above applies (then mandatory verification + handoff JSON)
- Skipping `nexus-run.js transition` gates before IMPLEMENTING / COMPLETED
- Dispatching LLM agents for graph rebuild, blast script, branch delete, or jq gates
- Finishing without required APPROVED handoff JSON(s) (`validate-handoff` + jq)
- Calling a prefixed `nexus-*` agent name instead of the canonical OpenCode name
