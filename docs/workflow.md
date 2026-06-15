# OpenCode Nexus Workflow

OpenCode Nexus provides a structured multi-agent development workflow:

1. Orchestrator creates and manages a task plan.
2. Implementer writes code and tests for each task on a feature branch.
3. Spec Reviewer checks requirement fidelity.
4. Code Reviewer checks quality and risks.
5. Orchestrator closes the branch workflow with an explicit user decision.

The workflow uses filesystem artifacts in `.opencode/` for durable coordination:

- `.opencode/plans/PLAN.md`
- `.opencode/CONTEXT.md`
- `.opencode/tasks/task-N.md`
- `.opencode/handoffs/task-N-<role>.json`

This keeps execution resilient across long sessions and context compaction.

## Orchestrator task permissions

The orchestrator agent denies all subagent dispatch by default (`"*": deny`) and then allows only `implementer`, `spec-reviewer`, and `code-reviewer`. OpenCode evaluates permission rules with **last matching rule wins**, so the wildcard must come first and specific `allow` entries after. Do not reorder these rules — see [OpenCode permissions docs](https://opencode.ai/docs/permissions/).
