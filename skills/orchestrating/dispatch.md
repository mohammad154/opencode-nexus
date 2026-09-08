# Subagent Dispatch (OpenCode) — V5 fixed execution pipeline

Portable CLI:

```bash
nexus project-init
nexus run init --run-id <id>
nexus next
nexus impact --json --targets <files>
nexus plan-check --json
nexus estimate --units N --planning-mode standard
```

Execution roles (only these):

| Role         | Canonical key | When                                      |
| ------------ | ------------- | ----------------------------------------- |
| Implementer  | `implementer` | After fresh pre-impact + branch ready     |
| Reviewer     | `reviewer`    | After VERIFYING for **every** task        |

Planning-only role:

| Role | Canonical key | When |
|---|---|---|
| Plan Advisor | `plan-advisor` | Once for standard/deep planning; never during execution |

Deterministic ops (do **not** dispatch an agent):

| Op        | Command |
|-----------|---------|
| Next step | `nexus next` / `nexus next --json` |
| Run / gates | `nexus run <init\|transition\|validate-handoff\|status\|resume\|drift>` |
| Impact    | `nexus impact --json --targets …` |
| Cleanup   | `bash scripts/nexus-branch-cleanup.sh --base <base> --out <json> <branches...>` |
| Plan lint  | `nexus plan-check --json` |
| Call est. | `nexus estimate --units N --planning-mode standard` |

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

### APPROVED (unit scope)

- More units → next unit `TASK_IMPACT_READY` with fresh impact (`next_task: true`).
- No more tasks → `FINAL_REVIEWING` with the **task** handoff + task `review_package`.

For a single unit only, the task reviewer evidence may be reused for final
verification when the reviewed commit equals current HEAD, the package digest
still matches, and no code changed after review. Pass
`reuse_final_review: true`; the state machine validates the binding and does not
silently skip the evidence checks.

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
- Skipping `nexus review-package` or jumping from last task APPROVED straight to `FINAL_VERIFYING` without the explicit single-unit digest/HEAD reuse evidence
- Using `review_scope: task` for ordinary `FINAL_VERIFYING` (only the explicit single-unit reuse path may retain task scope)
