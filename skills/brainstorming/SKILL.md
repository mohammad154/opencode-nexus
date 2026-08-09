---
name: brainstorming
description: Use before writing or executing a plan to clarify goals, constraints, and acceptance criteria – optionally augmented by Graphify context
compatibility: opencode
---

# Brainstorming

Before planning:

1. Restate user goal in plain language.
2. Identify technical constraints and trade-offs.
3. If `graphify-out/graph.json` exists, run `graphify query` or `graphify affected` and skim hub/related files to ground questions in real codebase structure (not guesses) – e.g. "this touches `src/auth/*` which is a hub with 12 dependents – should scope include middleware?"
4. Ask focused clarifying questions if needed – tie questions to file:line evidence when possible (from graph discovery or rg).
5. Define success criteria and non-goals.
6. Propose a preferred approach with rationale, citing past LESSONS.md entry if relevant on similar area.

Output must include:
- Problem framing
- Current code reading (file:line evidence for questions, if any)
- Graphify insight (when graph present: relevant hub nodes, dependent files near proposed change, languages)
- Suggested implementation direction with trade-offs
- Risks and mitigations (including blast awareness: is proposed area HIGH blast in graph?)
- Clear handoff into `writing-plans` – note whether verification baseline exists, and whether a fresh directed Graphify graph is present for accurate planning

Optional but recommended: `graphify query "<architecture question>"` early in brainstorming when the graph exists; run `graphify extract . --code-only --directed --no-viz` when it is missing.
