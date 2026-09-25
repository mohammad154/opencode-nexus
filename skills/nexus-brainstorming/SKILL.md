---
name: nexus-brainstorming
description: Clarify goals, constraints, and acceptance criteria before writing a plan. Ask questions only when genuinely ambiguous.
compatibility: opencode
---

# Brainstorming (V5)

Before planning:

1. Restate the user goal in plain language.
2. Skim the repository for the relevant area (rg / file reads). Prefer Nexus Impact Engine over guessing structure.
3. Identify technical constraints and trade-offs.
4. Build a small decision tree: record settled decisions and the current
   **frontier** — every decision whose prerequisites are already settled.
5. Resolve facts yourself with repository reads, deterministic commands, and
   read-only agents. Do not ask the user for file paths, test commands, Git
   state, or other facts the environment can provide.
6. Ask one consolidated round containing every currently answerable unresolved
   decision, with a recommended answer for each. Do not ask downstream
   questions whose prerequisites are still open.
7. Define success criteria and non-goals, then propose the preferred approach
   with rationale.

## Ambiguity gate

Enough information?

- **Yes** → no question → hand off to `nexus-writing-plans` immediately.
- **No** → ask the whole current frontier in one round, record the answers,
  recompute the frontier, and continue brainstorming.

The user-wait state is a planning decision boundary, not a general checkpoint.
After the plan is confirmed, continue the deterministic gates and subagent
loop automatically. Ask again only for a critical approval such as a
configured merge prompt, push/PR, force-discard, destructive migration/data
loss, secrets/external side effect, or material scope change.

Examples:

- "Add CSV export to reports." + clear report module → brainstorm → plan (no question).
- "Change authentication system." without JWT/session/OAuth/compat choice →
  ask the frontier question with a recommendation.

## Output

- Problem framing
- Current code reading (file:line when asking questions)
- Suggested implementation direction with trade-offs
- Risks and mitigations
- Clear handoff into `nexus-writing-plans`

Use `nexus impact` once targets are known for optional analysis — never block
brainstorming on external graph tooling. Do not act on the plan until every
frontier decision is settled and the user has confirmed shared understanding,
unless the original request already settles those decisions unambiguously.
