# Nexus V4 workflow

Nexus is an evidence-driven multi-agent workflow for OpenCode. The orchestrator coordinates; the implementer codes; reviewers stay read-only; **scripts own measurement and gates**.

## Lifecycle

```text
request → classify → plan → impact → implement → verify → review → final verify → finish
```

Durable state: `.opencode/runs/<run-id>/state.json`

States: `CREATED` → `CLASSIFIED` → `PLANNED` → `IMPACT_READY` → `IMPLEMENTING` → `VERIFYING` → `REVIEWING` → `FINAL_VERIFYING` → `COMPLETED`

## Impact Engine (replaces Graphify/blast)

```bash
nexus impact --json
# or
node scripts/nexus-impact.js --json --base HEAD
```

Produces sealed impact reports with separate **risk** and **confidence**, changed symbols, dependents, and related tests.

```bash
nexus run transition --to IMPACT_READY
```

## Verification

Baseline before edits → `.opencode/runs/<id>/baseline.json`. Agent test claims are re-run by scripts. Direct mode is limited to `documentation` and `formatting`.

## TDD

Implementer handoffs for behavioral changes should include:

```json
{
  "tdd": {
    "red": { "command": "npm test -- …", "exit_code": 1 },
    "green": { "command": "npm test -- …", "exit_code": 0 }
  }
}
```

## Isolation

Per-task git worktrees under `.opencode/worktrees/<task-id>/` with scope locks (`allowed_files`). Out-of-scope edits require re-impact.

## Review

Spec → code (or unified) → integration reviewer on the whole branch → `FINAL_VERIFYING` → `COMPLETED`.

No self-approval. Unresolved HIGH findings block final verify.

## Inspect

```bash
nexus run inspect --run-id <id>
```

## Agent roster

```text
orchestrator
implementer
diagnostician
unified-reviewer
spec-reviewer
code-reviewer
integration-reviewer
reconciler
```

`blast-analyzer` is obsolete; use the Impact Engine.
