---
name: brainstorming
description: Clarify goals, constraints, and acceptance criteria before writing a plan. Ask questions only when genuinely ambiguous.
compatibility: opencode
---

# Brainstorming (V5)

Before planning:

1. Restate the user goal in plain language.
2. Skim the repository for the relevant area (rg / file reads). Prefer Nexus Impact Engine over guessing structure.
3. Identify technical constraints and trade-offs.
4. **Ask focused clarifying questions only if needed.** If the repo + prompt are enough to plan, do **not** invent questions.
5. Define success criteria and non-goals.
6. Propose a preferred approach with rationale.

## Ambiguity gate

Enough information?

- **Yes** → no question → hand off to `writing-plans` immediately.
- **No** → ask a specific question → wait for the user → continue brainstorming.

Examples:

- "Add CSV export to reports." + clear report module → brainstorm → plan (no question).
- "Change authentication system." without JWT/session/OAuth/compat choice → ask one concrete question.

## Output

- Problem framing
- Current code reading (file:line when asking questions)
- Suggested implementation direction with trade-offs
- Risks and mitigations
- Clear handoff into `writing-plans`

Graphify (if present) is an **optional** analysis aid only — never block brainstorming on it. Prefer `nexus impact` once targets are known.
