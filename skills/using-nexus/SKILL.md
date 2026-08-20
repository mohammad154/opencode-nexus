---
name: using-nexus
description: Use when starting any Nexus session - establishes automatic skill selection and workflow routing for orchestrator-driven development with Impact Engine, TDD, and profile awareness
compatibility: opencode
---

# Using Nexus (V4 — evidence-driven workflow engine)

<SUBAGENT-STOP>
If you were dispatched as a subagent (implementer, diagnostician, spec-reviewer, code-reviewer, unified-reviewer, integration-reviewer, or reconciler), skip this skill.
</SUBAGENT-STOP>

## The Rule

**Invoke the relevant Nexus skill BEFORE responding or acting** when the task is non-trivial.

Direct mode is only for `documentation` / `formatting` with classifier `direct_eligible`.

Announce: "Using brainstorming to clarify requirements. (V4: Impact Engine + TDD + final verify)"

## Skill Router

| Situation | Skill to load |
|-----------|---------------|
| New feature, unclear scope | `brainstorming` |
| Need a plan file | `writing-plans` |
| Need impact / affected tests | `impact-analysis` — run `nexus impact --json` |
| Plan exists, start implementation | `orchestrating` |
| Feature/task branch | `using-feature-branches` |
| Execution stuck / BLOCKED | `reconcile` |
| Reflect / LESSONS | `outcome-memory` (under `.opencode/memory`) |
| Workflow complete | `finishing-a-development-branch` |

## Workflow engine gates

```text
CREATED → CLASSIFIED → PLANNED → IMPACT_READY → IMPLEMENTING → VERIFYING → REVIEWING → FINAL_VERIFYING → COMPLETED
```

```bash
nexus run init --run-id <id>
nexus run transition --to IMPACT_READY
nexus run inspect --run-id <id>
```
