# Subagent Dispatch (OpenCode) — V5 fixed pipeline

Portable CLI:

```bash
nexus project-init
nexus run init --run-id <id>
nexus next
nexus impact --json --targets <files>
nexus estimate --tasks N
```

Canonical roles (only these):

| Role         | Canonical key | When                                      |
| ------------ | ------------- | ----------------------------------------- |
| Implementer  | `implementer` | After fresh pre-impact + branch ready     |
| Reviewer     | `reviewer`    | After VERIFYING for **every** task        |

Deterministic ops (do **not** dispatch an agent):

| Op        | Command |
|-----------|---------|
| Next step | `nexus next` / `nexus next --json` |
| Run / gates | `nexus run <init\|transition\|validate-handoff\|status\|resume\|drift>` |
| Impact    | `nexus impact --json --targets …` |
| Cleanup   | `bash scripts/nexus-branch-cleanup.sh --base <base> --out <json> <branches...>` |
| Call est. | `nexus estimate --tasks N` |

Obey `REQUIRED_DISPATCH` from `nexus next` (or the injected **Nexus Next Action** block) before inventing other work.

## Review gate (always)

After implementer returns `DONE` or `DONE_WITH_CONCERNS`:

1. Do not review in the orchestrator turn.
2. Dispatch **reviewer** with [`reviewer-prompt.md`](reviewer-prompt.md).
3. Wait `.opencode/handoffs/<id>-reviewer.json` verdict.

```bash
jq -e '.verdict=="APPROVED"' .opencode/handoffs/<id>-reviewer.json
```

### REQUEST_CHANGES (automatic fix loop)

1. Extract findings from the reviewer handoff.
2. Fresh `nexus impact` for the updated scope.
3. `TASK_IMPACT_READY` with `review_handoff` + new impact.
4. Dispatch implementer with `review_findings`.
5. VERIFYING → reviewer again until APPROVED.

### APPROVED

- More tasks → next task `TASK_IMPACT_READY` with fresh impact (`next_task: true`).
- No more tasks → `FINAL_VERIFYING` → `COMPLETED`.

## Anti-patterns

- Dispatching retired agents (spec/code/unified/integration/diagnostician/reconciler)
- Skipping reviewer for "small" or "docs" changes
- Skipping pre-impact before any implementer dispatch (including fix loops)
- Waiting for the user to say "fix review issues"
