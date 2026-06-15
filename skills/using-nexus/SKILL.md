---
name: using-nexus
description: Use when starting a session to load the OpenCode Nexus workflow and context-preservation rules
compatibility: opencode
---

# Using Nexus

This skill defines the baseline behavior for the Nexus workflow.

<SUBAGENT-STOP>
Subagents must not reload this skill unless explicitly asked.
</SUBAGENT-STOP>

## Core Workflow

1. Brainstorm before planning.
2. Write or update `.opencode/plans/PLAN.md`.
3. Drive execution task-by-task through orchestrating.
4. Use feature branches and two-stage review.
5. Finalize with finishing-a-development-branch.

## Context Preservation Rules

- Keep durable state in files, not only in chat context.
- Update `.opencode/CONTEXT.md` after each major state change.
- Require machine-readable handoff JSON per completed subagent run.
- Dispatch subagents with full task text and acceptance criteria.
