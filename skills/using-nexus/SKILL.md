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

`plan-advisor` is a planning-only specialist, not a fourth execution agent. Use
it once for standard/deep plans when decomposition or architecture uncertainty
justifies the call; compact plans may omit it.

## Skill Router

| Situation | Skill to load |
|-----------|---------------|
| New request / unclear scope | `brainstorming` |
| Need a plan file | `writing-plans` |
| Challenge a standard/deep plan | `plan-advisor` (one read-only call) |
| Lint a plan before PLANNED | `nexus plan-check --json` |
| Need impact / affected tests | `impact-analysis` — run `nexus impact --json` |
| Plan exists, start implementation | `orchestrating` |
| Feature/task branch | `using-feature-branches` |
| Execution stuck / BLOCKED | `reconcile` |
| Workflow complete | `finishing-a-development-branch` |

## Workflow engine gates

```text
CREATED → BRAINSTORMING ↔ WAITING_FOR_USER → PLANNED
  → TASK_IMPACT_READY → IMPLEMENTING → VERIFYING → REVIEWING
  → (REQUEST_CHANGES → TASK_IMPACT_READY) | FINAL_VERIFYING → COMPLETED
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
