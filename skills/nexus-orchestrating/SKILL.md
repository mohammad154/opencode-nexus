---
name: nexus-orchestrating
description: Execute a plan through the V5 fixed state machine — adaptive planning, cohesive execution units, deterministic verification, independent review, and fix loops
compatibility: opencode
---

# Orchestrating (V5 — fixed execution pipeline)

Agent claims are never evidence. Scripts measure; the state machine seals provider output; implementers code; the reviewer is read-only.

## Continuous execution

The orchestrator owns a continuous controller loop. Once brainstorming has
settled the current decision frontier and the plan is confirmed, execute the
next deterministic command, dispatch the required subagent, consume its
handoff, and re-run `nexus next` in the same turn. Do not return control to the
user for routine transitions, tests, verification, reviewer dispatches,
`REQUEST_CHANGES` fix loops, verification resumes, local merge, or guarded
cleanup.

Pause only for `WAITING_FOR_USER` planning clarification, a critical approval
(configured `merge_policy: prompt`, push/PR, force-discard, destructive
migration/data loss, secrets/deploy/external side effect, or material scope
change), a non-repairable/manual evidence repair, or an environment permission/error
that cannot be resolved safely. A passing final verification authorizes
`COMPLETED`; it does not authorize unrelated external side effects.

## Execution invariants

1. Every request: **nexus-brainstorming** → **nexus-writing-plans**.
2. Every implementer dispatch: **fresh pre-impact**.
3. Every task: independent **reviewer** `APPROVED`.

The execution roster remains three agents: orchestrator, implementer, reviewer.
`plan-advisor` is a conditional planning-only specialist and is never dispatched
in the implementation/review loop.

Planning depth and independent planning challenge are two separate decisions.

Depth:

- `compact`: one cohesive unit, established pattern, known non-HIGH impact, small
  review surface, no semantic signal. Size is a signal, not the rule.
- `standard`: ordinary feature.
- `deep`: migration, public contract, security boundary, destructive change, or
  HIGH/CRITICAL/UNKNOWN impact.

Challenge: Nexus derives `plan_advisor_decision` from the reported evidence. It
is **required** for any hard safety signal (public contract, security boundary,
migration, destructive change, architectural choice, multiple subsystems,
HIGH/CRITICAL/UNKNOWN impact), for deep planning, for declared uncertainty, and
whenever the evidence is too thin to judge. It is **not required** for a clear,
cohesive, known-pattern task — so a `standard` plan with zero advisor calls is
normal, not a skipped step.

Report evidence, not conclusions: `change_class`, `unit_count`, `cohesive_unit`,
`known_pattern`, `risk`, plus any of `decomposition_uncertain`,
`planning_uncertainty`, or `open_questions`. You can raise the requirement; you
cannot clear a deterministic trigger, and declaring `compact` over a
disqualifying signal is rejected at `PLANNED`. `nexus next` routes the dispatch.

If the advisor cannot start because its model is missing, stop and fix
`plan-advisor.model` in OpenCode config. Do not forge advisor evidence and do not
claim cohesion or a known pattern you have not established.

Before `PLANNED`, run `nexus plan-check --json`. It is deterministic and checks
the execution-unit DAG, acceptance and verification ownership, scope overlap,
merge candidates, oversized/test-only/setup-only units, and estimated calls.

## Prerequisites

- Confirm the workspace is a git repository.
- Load `nexus-using-feature-branches` and record `base_branch` in `.opencode/CONTEXT.md`.
- If drift is suspected, run `nexus-reconcile` (skill) before starting tasks.
- Graphify is not part of Nexus. Use `nexus impact`.

## Lifecycle

```text
CREATED → BRAINSTORMING ↔ WAITING_FOR_USER → PLANNED
  → TASK_IMPACT_READY (pre-impact per unit)
  → IMPLEMENTING → VERIFYING (PENDING) → `nexus verify` → VERIFYING (PASSED)
  → eligible FAILED → TASK_IMPACT_READY (one bounded automatic repair)
  → REVIEWING
       ├── REQUEST_CHANGES → TASK_IMPACT_READY (fresh impact) → …
       └── APPROVED → next unit TASK_IMPACT_READY | FINAL_REVIEWING → FINAL_VERIFYING → COMPLETED
```

One command runs the deterministic chain for you. `nexus advance` executes every
scripted step the current state allows — plan-check, pre-impact, drift, the
authorization transitions, `nexus verify`, the review package — then stops at the
next boundary that needs judgement and returns the prepared dispatch:

```bash
nexus advance            # human summary
nexus advance --json     # machine-readable steps + prepared dispatch
nexus advance --dry-run  # show the next deterministic step, run nothing
nexus trace              # what is still uncovered (exit 3 = not converged)
nexus lane plan          # units whose implementers may run concurrently
```

It stops (never guesses) at: your own brainstorm/plan work, an agent dispatch, a
user question, any `BLOCKED`/reconcile/verification-repair path, and any gate
rejection — the gate's reason is reported verbatim and advance never retries with
different evidence. Everything below is the same chain spelled out; use it when
you need a single step or when advance reports a boundary you must resolve.

```bash
nexus run init --run-id <id>
nexus run transition --to BRAINSTORMING
# report planning depth and evidence; Nexus decides if an advisor call is required:
nexus run transition --to BRAINSTORMING --json '{"planning_mode":"standard","unit_count":1,"cohesive_unit":true,"known_pattern":true,"risk":"LOW"}'
nexus next   # dispatch_plan_advisor only when the persisted decision requires it
# nexus-writing-plans creates PLAN.md, then the deterministic check runs first:
nexus plan-check --json
nexus run transition --to PLANNED
nexus impact --json --targets <planned files>
nexus run transition --to TASK_IMPACT_READY --json '{"planned_targets":["src/foo.js"]}'
nexus run transition --to IMPLEMENTING --branch <b> --unit unit-1 --acceptance 'c1|c2'
nexus run transition --to VERIFYING --json '{"implementer_handoff":{...}}'
nexus verify
nexus run transition --to REVIEWING
# Multi-unit: FINAL_REVIEWING → final reviewer → FINAL_VERIFYING.
# Single-unit reuse is explicit and requires the bound task package evidence:
nexus run transition --to FINAL_VERIFYING --json '{"reuse_final_review":true,"review_handoff":{...},"review_package":{...}}'
nexus verify
nexus run transition --to COMPLETED
```

## Guarded parallel execution

For independent units, run the implementers concurrently instead of one at a time:

1. `nexus lane plan --max-concurrency 2` — the wave, plus a reason for every
   excluded unit.
2. `nexus lane start --unit <id>` per unit in the wave, then dispatch one
   implementer inside each lane worktree with pre-impact measured there.
3. Authorize the unit in the parent as usual, then `nexus lane join --unit <id>`.
   The join rebases the lane onto the parent tip and leaves an ordinary
   implementer handoff; `nexus advance` takes it from there.

Only the implementer is parallel. Verification, the per-unit task review, the
final review, and convergence are unchanged, so the agent-call count matches a
sequential run. A refused join is final: on a conflict the disjointness
assumption was wrong, so abort the lane and implement that unit sequentially.

## Convergence

`COMPLETED` requires every planned execution unit to have an approved task review
and every planned acceptance criterion to have a passing result from it. Two
consequences for the loop:

- Authorize work only under a planned unit id. `IMPLEMENTING` rejects a
  `current_unit` the plan never declared.
- Do not route to the final review while units remain. If you do, the gate names
  the missing unit; run `nexus trace` to see the ledger, then finish that unit.

Dropping a planned unit is a plan change, not a shortcut: re-plan explicitly
rather than leaving it unimplemented.

## Verification boundary

`IMPLEMENTING → VERIFYING` and `FINAL_REVIEWING → FINAL_VERIFYING` are fast
authorization transitions. They persist a commit binding and `PENDING`; they
must not run post-impact, tests, lint, build, type checks, or create a verifier
Task. `nexus verify` is deterministic provider execution, not an LLM agent.

It writes durable progress to `.opencode/runs/<run-id>/verification.json`.
On `TIMED_OUT` or `RUNNING`, use `nexus verify --resume`; never return to
`IMPLEMENTING` merely because a check timed out. `REVIEWING` requires a sealed
task verification `PASSED`; `COMPLETED` requires sealed final verification
`PASSED`.

## Delegation gate

1. Missing `.opencode/` → `nexus project-init` then `nexus run init`.
2. Before `IMPLEMENTING` → complete brainstorm → plan → **pre-impact**. Do not edit production files. `nexus advance` performs the deterministic part of this and hands back the prepared implementer dispatch; it never writes production code, handoffs, or verdicts.
3. At `IMPLEMENTING` → only dispatch **implementer** via Task tool.
4. In `VERIFYING` / `FINAL_VERIFYING` → follow `nexus next`: run deterministic `nexus verify`, resume a timeout with `nexus verify --resume`, and for one current sealed executed-check failure run fresh impact and re-enter `TASK_IMPACT_READY` once. Non-repairable failures remain manual; never dispatch a verifier subagent.
5. After `VERIFYING/PASSED → REVIEWING` → build the package (`nexus advance`, or `nexus review-package --scope task|final`) and dispatch **reviewer** (see [`reviewer-prompt.md`](reviewer-prompt.md)). The package is a selection; the reviewer consumes sealed verification instead of re-running it and declares any probe in `adversarial_checks` with a hypothesis, command, and reason.
5. On verification failure, let `nexus next` choose the guarded automatic repair or manual reconciliation. On `REQUEST_CHANGES` → extract findings → fresh pre-impact → implementer → verify → reviewer. Do not ask the user to "fix review issues".

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
3. Fast transition to VERIFYING, then `nexus verify` (post-impact + provider verification)
4. Only after verification PASSED: transition to REVIEWING and dispatch reviewer
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
