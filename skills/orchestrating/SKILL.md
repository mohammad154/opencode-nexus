---
name: orchestrating
description: Execute a plan through the V5 fixed state machine — brainstorm, plan, pre-impact, implementer, post-impact, reviewer, auto fix-loop
compatibility: opencode
---

# Orchestrating (V5 — fixed pipeline)

Agent claims are never evidence. Scripts measure; the state machine seals provider output; implementers code; the reviewer is read-only.

## Three invariants

1. Every request: **brainstorming** → **writing-plans**.
2. Every implementer dispatch: **fresh pre-impact**.
3. Every task: independent **reviewer** `APPROVED`.

## Prerequisites

- Confirm the workspace is a git repository.
- Load `using-feature-branches` and record `base_branch` in `.opencode/CONTEXT.md`.
- If drift is suspected, run `reconcile` (skill) before starting tasks.
- Graphify is not part of Nexus. Use `nexus impact`.

## Lifecycle

```text
CREATED → BRAINSTORMING ↔ WAITING_FOR_USER → PLANNED
  → TASK_IMPACT_READY (pre-impact)
  → IMPLEMENTING → VERIFYING (provider tests + post-impact)
  → REVIEWING
       ├── REQUEST_CHANGES → TASK_IMPACT_READY (fresh impact) → …
       └── APPROVED → next task TASK_IMPACT_READY | FINAL_VERIFYING → COMPLETED
```

```bash
nexus run init --run-id <id>
nexus run transition --to BRAINSTORMING
# writing-plans must create .opencode/plans/PLAN.md first:
nexus run transition --to PLANNED
nexus impact --json --targets <planned files>
nexus run transition --to TASK_IMPACT_READY --json '{"planned_targets":["src/foo.js"]}'
nexus run transition --to IMPLEMENTING --branch <b> --acceptance 'c1|c2'
nexus run transition --to VERIFYING --json '{"implementer_handoff":{...}}'
nexus run transition --to REVIEWING
nexus run transition --to FINAL_VERIFYING --json '{"review_handoff":{...}}'
nexus run transition --to COMPLETED
```

## Delegation gate

1. Missing `.opencode/` → `nexus project-init` then `nexus run init`.
2. Before `IMPLEMENTING` → complete brainstorm → plan → **pre-impact**. Do not edit production files.
3. At `IMPLEMENTING` → only dispatch **implementer** via Task tool.
4. After VERIFYING → always dispatch **reviewer** (see [`reviewer-prompt.md`](reviewer-prompt.md)).
5. On `REQUEST_CHANGES` → extract findings → fresh pre-impact → implementer → verify → reviewer. Do not ask the user to "fix review issues".

## Next action (deterministic)

Every turn the plugin injects a **Nexus Next Action** block (also available via CLI):

```bash
nexus next
nexus next --json
nexus next --run-id <id>
```

When `REQUIRED_DISPATCH` is set (`implementer` or `reviewer`), Task-dispatch that agent before doing anything else. Do not invent a different next step.

## Per-task loop

For each plan task:

1. Pre-impact (`nexus impact`) → `TASK_IMPACT_READY`
2. Dispatch implementer with impact context (dependents, callers, related tests)
3. VERIFYING (post-impact + provider verification)
4. Dispatch reviewer
5. If REQUEST_CHANGES → go to step 1 with findings
6. If APPROVED → next task or FINAL_VERIFYING

See [`dispatch.md`](dispatch.md).

## Estimate

```bash
nexus estimate --tasks <N>
```

Predictable model: ~2 agent calls per task (implementer + reviewer) plus fix-loop headroom.
