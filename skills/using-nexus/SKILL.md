---
name: using-nexus
description: Use when starting any Nexus session - establishes automatic skill selection and workflow routing for orchestrator-driven development
compatibility: opencode
---

# Using Nexus

<SUBAGENT-STOP>
If you were dispatched as a subagent (implementer, spec-reviewer, code-reviewer), skip this skill.
</SUBAGENT-STOP>

## The Rule

**Invoke the relevant Nexus skill BEFORE responding or acting.**

If there is even a 1% chance a Nexus skill applies, you MUST load it with OpenCode's `skill` tool. You do not need the user to name the skill.

Examples:
- User: "Add JWT auth" → load `brainstorming`, then `writing-plans`, then `orchestrating`
- User: "Continue task 2" → load `orchestrating`
- User: "All tasks are done" → load `finishing-a-development-branch`

Announce which skill you are using: "Using brainstorming to clarify requirements."

## Skill Router

| Situation | Skill to load |
|-----------|---------------|
| New feature, unclear scope, design questions | `brainstorming` |
| Requirements are clear, need a plan file | `writing-plans` |
| Plan exists, start or continue implementation | `orchestrating` |
| About to implement on a task branch | `using-feature-branches` |
| All tasks reviewed and approved | `finishing-a-development-branch` |

Skill order for new work:

1. `brainstorming`
2. `writing-plans`
3. `using-feature-branches` (when execution starts)
4. `orchestrating`
5. `finishing-a-development-branch`

## OpenCode Tool Mapping

- `Skill` tool → OpenCode `skill` tool
- `Task` subagent dispatch → `@implementer`, `@spec-reviewer`, `@code-reviewer`
- `TodoWrite` → `todowrite`

## Agent Selection

- Use **orchestrator** as the primary agent for end-to-end workflow.
- Dispatch subagents only through orchestrator permissions.

## Git requirement

This workflow requires a git repository for feature branches and review diffs.
If the project is not a git repo, ask the user to run `git init` (or open a git project) before orchestrating.

## Context Preservation Rules

- Keep durable state in files, not only in chat context.
- Update `.opencode/CONTEXT.md` after each major state change.
- Write handoff JSON to `.opencode/handoffs/`.
- Dispatch subagents with full task text and acceptance criteria pasted into the prompt.

## Red Flags

Stop and load a skill if you think:
- "The user didn't ask for a skill" → skills are automatic
- "I'll just start coding" → load `orchestrating` or `writing-plans` first
- "This is a simple change" → still follow Nexus workflow for multi-step work
