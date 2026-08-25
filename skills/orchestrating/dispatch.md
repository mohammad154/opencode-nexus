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
2. Generate a deterministic briefing: `nexus review-package --scope task --json`.
3. Dispatch **reviewer** with [`reviewer-prompt.md`](reviewer-prompt.md) and the package path. Do **not** prime the verdict.
4. Wait `.opencode/handoffs/<id>-reviewer.json`. Nexus admits APPROVED only when acceptance/checks/files_reviewed evidence is structurally valid.

```bash
nexus review-package --scope task --json
# Inspect verdict; empty APPROVED is gate-invalid
jq '{verdict, review_scope, acceptance, checks, files_reviewed, findings}' .opencode/handoffs/<id>-reviewer.json
```

### REQUEST_CHANGES (automatic fix loop)

1. Extract findings from the reviewer handoff.
2. Fresh `nexus impact` for the updated scope.
3. `TASK_IMPACT_READY` with `review_handoff` + new impact.
4. Dispatch implementer with `review_findings`.
5. VERIFYING → review-package → reviewer again until an **admissible** APPROVED.

### APPROVED (task scope)

- More tasks → next task `TASK_IMPACT_READY` with fresh impact (`next_task: true`).
- No more tasks → `FINAL_REVIEWING` with the **task** handoff + task `review_package`.

### Final whole-branch review

1. `nexus review-package --scope final --json`
2. Dispatch **reviewer** again with `review_scope: final` (cross-task integration in scope).
3. On APPROVED → `FINAL_VERIFYING` with the **final** handoff + final `review_package`.
4. Then deterministic final verification → `COMPLETED`.

## Anti-patterns

- Dispatching retired agents (spec/code/unified/integration/diagnostician/reconciler)
- Skipping reviewer for "small" or "docs" changes
- Skipping pre-impact before any implementer dispatch (including fix loops)
- Waiting for the user to say "fix review issues"
- Priming the reviewer toward APPROVED (expected outcomes, "should pass", sample verdict APPROVED)
- Accepting APPROVED with empty acceptance / no checks / no files_reviewed
- Skipping `nexus review-package` or jumping from last task APPROVED straight to `FINAL_VERIFYING`
- Using `review_scope: task` for `FINAL_VERIFYING` (must be `final`)
