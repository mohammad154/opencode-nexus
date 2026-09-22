---
name: using-nexus
description: Use when starting any Nexus session — establishes the fixed V5 skill router (brainstorm → optional plan-advisor → plan-check → impact → implement → review)
compatibility: opencode
---

# Using Nexus (V5 — fixed three-agent execution pipeline)

<SUBAGENT-STOP>
If you were dispatched as a subagent (plan-advisor, implementer, or reviewer), skip this skill.
</SUBAGENT-STOP>

## The Rule

**Invoke the relevant Nexus skill BEFORE responding or acting** when the task is non-trivial.

Announce: "Using brainstorming to clarify requirements. (V5: fixed pipeline + Impact Engine)"

## Three invariants

1. Every request starts with brainstorming and a plan.
2. Every implementer call requires fresh impact analysis.
3. Every implementation must be approved by an independent reviewer.

`plan-advisor` is a planning-only specialist, not a fourth execution agent. Nexus
derives whether it is required from planning evidence: any safety signal, deep
planning, declared uncertainty, or evidence too thin to judge requires it, while
a clear cohesive task — including a `standard` one — does not. Check
`nexus next`; do not decide by planning mode alone.

## Skill Router

| Situation | Skill to load |
|-----------|---------------|
| New request / unclear scope | `brainstorming` |
| Need a plan file | `writing-plans` |
| Challenge a plan when `plan_advisor_decision.required` | `plan-advisor` (one read-only call) |
| Lint a plan before PLANNED | `nexus plan-check --json` |
| Need impact / affected tests | `impact-analysis` — run `nexus impact --json` |
| Plan exists, start implementation | `orchestrating` |
| Feature/task branch | `using-feature-branches` |
| Execution stuck / BLOCKED | `reconcile` |
| Workflow complete | `finishing-a-development-branch` |

## Workflow engine gates

```text
CREATED → BRAINSTORMING ↔ WAITING_FOR_USER → PLANNED
  → TASK_IMPACT_READY → IMPLEMENTING → VERIFYING → `nexus verify` → REVIEWING
  → (REQUEST_CHANGES / eligible FAILED → TASK_IMPACT_READY) | FINAL_REVIEWING → FINAL_VERIFYING → `nexus verify` → COMPLETED
```

```bash
nexus run init --run-id <id>
nexus next                         # what to do right now (also injected every turn)
nexus run transition --to BRAINSTORMING
nexus run transition --to TASK_IMPACT_READY
nexus run inspect --run-id <id>
```

Execution agents: **orchestrator**, **implementer**, **reviewer**. Planning-only
advisor: **plan-advisor** (conditional; never in the implementation loop).
Verification is deterministic provider execution, not a fourth agent. Follow
`nexus next`: it sends `PENDING` to `nexus verify`, timeouts to
`nexus verify --resume`, one eligible current sealed check failure through fresh
impact and `TASK_IMPACT_READY`, and only a `PASSED` task verification to the
reviewer. It never dispatches a verifier subagent.
