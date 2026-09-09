---
name: orchestrating
description: Execute a plan through the V5 fixed state machine — adaptive planning, optional plan-advisor, cohesive execution units, pre-impact, implementer, post-impact, reviewer, auto fix-loop
compatibility: opencode
---

# Orchestrating (V5 — fixed execution pipeline)

Agent claims are never evidence. Scripts measure; the state machine seals provider output; implementers code; the reviewer is read-only.

## Execution invariants

1. Every request: **brainstorming** → **writing-plans**.
2. Every implementer dispatch: **fresh pre-impact**.
3. Every task: independent **reviewer** `APPROVED`.

The execution roster remains three agents: orchestrator, implementer, reviewer.
`plan-advisor` is a conditional planning-only specialist and is never dispatched
in the implementation/review loop.

Planning depth is adaptive:

- `compact`: tiny, low-risk changes; write the plan without an advisor.
- `standard`: ordinary feature; dispatch `plan-advisor` once with a Problem Brief.
- `deep`: migration/refactor/security/public-contract work; dispatch it once,
  and permit a second call only for a documented `CRITICAL_DISAGREEMENT`.

If the advisor cannot start because its model is missing, stop and fix
`plan-advisor.model` in OpenCode config. Do not forge advisor evidence and do
not silently downgrade to `compact` unless the change really is tiny.

Before `PLANNED`, run `nexus plan-check --json`. It is deterministic and checks
the execution-unit DAG, acceptance and verification ownership, scope overlap,
merge candidates, oversized/test-only/setup-only units, and estimated calls.

## Prerequisites

- Confirm the workspace is a git repository.
- Load `using-feature-branches` and record `base_branch` in `.opencode/CONTEXT.md`.
- If drift is suspected, run `reconcile` (skill) before starting tasks.
- Graphify is not part of Nexus. Use `nexus impact`.

## Lifecycle

```text
CREATED → BRAINSTORMING ↔ WAITING_FOR_USER → PLANNED
  → TASK_IMPACT_READY (pre-impact per unit)
  → IMPLEMENTING → VERIFYING (provider tests + post-impact)
  → REVIEWING
       ├── REQUEST_CHANGES → TASK_IMPACT_READY (fresh impact) → …
       └── APPROVED → next unit TASK_IMPACT_READY | FINAL_REVIEWING → FINAL_VERIFYING → COMPLETED
```

```bash
nexus run init --run-id <id>
nexus run transition --to BRAINSTORMING
# choose planning mode; standard/deep gets one independent advisor call:
nexus run transition --to BRAINSTORMING --json '{"planning_mode":"standard"}'
# writing-plans creates PLAN.md, then the deterministic check runs first:
nexus plan-check --json
nexus run transition --to PLANNED
nexus impact --json --targets <planned files>
nexus run transition --to TASK_IMPACT_READY --json '{"planned_targets":["src/foo.js"]}'
nexus run transition --to IMPLEMENTING --branch <b> --acceptance 'c1|c2'
nexus run transition --to VERIFYING --json '{"implementer_handoff":{...}}'
nexus run transition --to REVIEWING
# Multi-unit: FINAL_REVIEWING → final reviewer → FINAL_VERIFYING.
# Single-unit reuse is explicit and requires the bound task package evidence:
nexus run transition --to FINAL_VERIFYING --json '{"reuse_final_review":true,"review_handoff":{...},"review_package":{...}}'
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

When `REQUIRED_DISPATCH` is set (`plan-advisor`, `implementer`, or `reviewer`), Task-dispatch that agent before doing anything else. Do not invent a different next step.

## Per-unit loop

For each execution unit (the `task-*` state/file alias is retained):

1. Pre-impact (`nexus impact`) → `TASK_IMPACT_READY`
2. Dispatch implementer with impact context (dependents, callers, related tests)
3. VERIFYING (post-impact + provider verification)
4. Dispatch reviewer
5. If REQUEST_CHANGES → go to step 1 with findings
6. If APPROVED → next unit or FINAL_REVIEWING. For one unit, the task review
   may reach `FINAL_VERIFYING` directly only with evidence-bound reuse: approved
   task scope, matching current HEAD, unchanged package digest, and no code
   change after review.

See [`dispatch.md`](dispatch.md).

## Estimate

```bash
nexus estimate --units <N> --planning-mode standard
```

Predictable model: ~2 agent calls per execution unit (implementer + reviewer),
plus fix-loop headroom and at most one normal planning-advisor call.
