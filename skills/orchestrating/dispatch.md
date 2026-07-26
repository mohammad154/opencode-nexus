# Subagent Dispatch (all platforms)

Canonical roles (always the same):

| Role            | Canonical key     | When                             |
| --------------- | ----------------- | -------------------------------- |
| Implementer     | `implementer`     | After blast + branch ready       |
| Spec reviewer   | `spec-reviewer`   | After implementer handoff DONE\* |
| Code reviewer   | `code-reviewer`   | After spec verdict APPROVED      |
| Blast analyzer  | `blast-analyzer`  | Optional; scripts also OK        |
| Knowledge graph | `knowledge-graph` | Optional; scripts also OK        |
| Reconciler      | `reconciler`      | On BLOCKED / drift               |

## Resolve the local agent name

```text
local_name = <prefix> + <canonical key>
```

| Platform        | Prefix    | How you dispatch                        | Docs-backed path                                                                                                                  |
| --------------- | --------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **OpenCode**    | _(empty)_ | Task tool / `@spec-reviewer`            | `~/.config/opencode/agents/<key>.md` — [Agents](https://opencode.ai/docs/agents/)                                                 |
| **Claude Code** | `nexus-`  | Agent tool with `name:` frontmatter     | `~/.claude/agents/nexus-<key>.md` — [Subagents](https://code.claude.com/docs/en/sub-agents) (`name` + `description` required)     |
| **Cursor**      | `nexus-`  | Task `subagent_type`                    | `~/.cursor/agents/nexus-<key>.md` (also reads `.claude/agents`, `.codex/agents`) — [Subagents](https://cursor.com/docs/subagents) |
| **Antigravity** | `nexus-`  | Skill-driven / Agent if available       | Skills: `~/.gemini/config/skills/nexus-*/` + `.agents/skills/` — [Skills](https://antigravity.google/docs/skills)                 |
| **Codex**       | `nexus-`  | `$nexus-orchestrating` / isolated turns | Skills: `$HOME/.agents/skills/nexus-*/` (+ `~/.codex/skills`) — [Skills](https://developers.openai.com/codex/skills)              |
| **Gemini CLI**  | `nexus-`  | Skill activation / isolated turns       | `~/.gemini/skills/nexus-*/` + `~/.agents/skills/` — [Skills](https://geminicli.com/docs/cli/skills/)                              |

**Rule:** Prefer the installed agent whose `name` / filename matches. OpenCode = bare key. Everyone else = `nexus-<key>`. Never invent a third name.

### Skill discovery (workflow router)

| Platform    | Skills live at                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode    | plugin `skills/` path + `skill` tool                                                                                               |
| Claude      | `~/.claude/skills/nexus-*/SKILL.md`                                                                                                |
| Cursor      | `~/.cursor/skills/nexus-*/` + `~/.agents/skills/` + rules `~/.cursor/rules/nexus-*.mdc` — [Skills](https://cursor.com/docs/skills) |
| Codex       | `$HOME/.agents/skills/nexus-*/` (primary) and `~/.codex/skills/nexus-*/`                                                           |
| Gemini      | `~/.gemini/skills/nexus-*/` and `~/.agents/skills/`                                                                                |
| Antigravity | `~/.gemini/config/skills/nexus-*/` (universal) + `.agents/skills/` (workspace)                                                     |

Skill frontmatter `name:` **must equal the folder name** (e.g. folder `nexus-orchestrating` → `name: nexus-orchestrating`).

## Mandatory two-stage review (blocking gates)

After implementer returns `DONE` or `DONE_WITH_CONCERNS`:

1. **Do not** review in the orchestrator turn. **Do not** mark the task done yet.
2. Dispatch **spec-reviewer** (resolved local name) with the filled `spec-reviewer-prompt.md`.
3. Wait until `.opencode/handoffs/task-N-spec-reviewer.json` exists with `"verdict": "APPROVED"`.
4. Only then dispatch **code-reviewer** (resolved local name) with the filled `code-reviewer-prompt.md`.
5. Wait until `.opencode/handoffs/task-N-code-reviewer.json` exists with `"verdict": "APPROVED"`.
6. Then outcome-memory → mark done → finishing/merge.

### Gate commands (run before finishing task N)

```bash
jq -e '.status=="DONE" or .status=="DONE_WITH_CONCERNS"' .opencode/handoffs/task-N-implementer.json
jq -e '.verdict=="APPROVED"' .opencode/handoffs/task-N-spec-reviewer.json
jq -e '.verdict=="APPROVED"' .opencode/handoffs/task-N-code-reviewer.json
```

If any gate fails → do not finish the task.

### Fix loops

- Spec `REQUEST_CHANGES` / `ISOLATION_VIOLATION` / `BLOCKED` → implementer fixes → **re-run spec** (then code only after APPROVED). Max 3 loops, then escalate.
- Code `REQUEST_CHANGES` / … → implementer fixes → **re-run both** stages from spec. Max 3 loops, then escalate.

## Platform notes (from official docs)

### OpenCode

- Markdown agents under `~/.config/opencode/agents/`; filename = agent id.
- Orchestrator uses `permission.task` allow-list (`*` deny, then named allows). Last matching rule wins.
- Invoke: Task tool or `@spec-reviewer`.

### Claude Code

- Subagent identity comes from frontmatter **`name:`**, not the filename.
- Installer writes `name: nexus-spec-reviewer` + Claude `tools:` allowlist.
- Orchestrator tools include `Agent(nexus-implementer, nexus-spec-reviewer, …)` so only Nexus reviewers can be spawned.
- Reviewers get `Write` only so they can create handoff JSON under `.opencode/handoffs/` (prompt forbids other edits).

### Cursor

- Custom subagents: `.cursor/agents/*.md` with `name` + `description` + non-empty body.
- Task `subagent_type` must be the agent `name` (e.g. `nexus-spec-reviewer`).
- Also install skills under `.cursor/skills/` / `.agents/skills/` (progressive disclosure).
- Do **not** set `readonly: true` on reviewers — they must write handoff JSON.

### Codex / Gemini / Antigravity

- Primarily skill-driven. Load `nexus-using-nexus` / `nexus-orchestrating`.
- If no Agent/Task tool: run two **isolated** reviewer turns with the prompt templates and still write handoff JSON.
- Gates above still apply.

## Anti-patterns (all platforms)

- Skipping either reviewer (“small change”, “looks fine”, “tests passed”)
- Parallel spec + code review
- Code review before spec APPROVED
- Self-review inside the orchestrator/implementer turn instead of a separate dispatch
- Using a random general agent **instead of** the named reviewer when the named agent exists
- Finishing/merging without both APPROVED handoff JSONs
- Calling the wrong name for the platform (bare `spec-reviewer` where only `nexus-spec-reviewer` is installed)
- Skill `name:` not matching folder name (Cursor/Codex/Gemini discovery)
