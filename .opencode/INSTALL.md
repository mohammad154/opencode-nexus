# Installing OpenCode Nexus V5

Nexus V5 has a **fixed three-agent execution pipeline** and an OpenCode
installer. The core owns workflow states, the Impact Engine, verification gates,
handoffs, and always-on review. The installer writes native OpenCode agents and
merges plugin/model config. A conditional `plan-advisor` is planning-only and
never enters the execution loop.

## Prerequisites

- `node` (≥20) for Impact Engine, verification, and the CLI
- `jq` for OpenCode configuration merging and uninstall cleanup
- `git` for change evidence, worktrees, and branch workflows

## Install

```bash
npx @mohammad154/opencode-nexus@latest install
nexus doctor
```

Or:

```bash
npm install -g @mohammad154/opencode-nexus@latest
nexus install
```

## OpenCode outputs

| Output | Path |
|---|---|
| Agents | `~/.config/opencode/agents/*.md` |
| Plugin and models | `~/.config/opencode/opencode.json` |

Canonical execution agents (V5):

`orchestrator`, `implementer`, `reviewer`.

Planning-only specialist:

`plan-advisor` — used once for `standard`/`deep` planning when warranted; it is
read-only and cannot write code or change run state.

Install writes skill permissions into `opencode.json`: global `nexus-*` is
denied, the orchestrator is allowed `nexus-*`, and implementer and reviewer
are allowed only `nexus-impact-analysis`. build, plan, custom agents, and
plan-advisor inherit the deny.

## Uninstall

```bash
nexus uninstall
npm uninstall -g @mohammad154/opencode-nexus
```

Uninstall removes the Nexus skill permission keys (`permission.skill["nexus-*"]`
and the per-agent skill allows) and restores a pre-existing value for the same
key. Other skill rules and unrelated permission entries stay.

Uninstall removes Nexus agents, plugin/config entries, permission rules, model
files, OpenCode package-cache copies, local plugin overrides, CLI PATH helpers,
and installer backups. It restores pre-existing agent/config entries when
provenance is available and leaves unrelated OpenCode configuration and
project-local `.opencode/` data untouched. Run the Nexus command before global
npm removal: npm 7 and newer do not run package uninstall lifecycle scripts, so
`npm uninstall` alone cannot clean the shared OpenCode configuration.

## Three invariants

1. Every request starts with brainstorming and a plan.
2. Every implementer call requires fresh impact analysis.
3. Every implementation must be approved by an independent reviewer.

After the plan is confirmed, the orchestrator continues deterministic gates and
subagent dispatches automatically in the same turn, including eligible
verification-repair loops, verification resume, reviewer `REQUEST_CHANGES`
loops, final verification, and default local
branch merge/cleanup. It asks only for unresolved planning decisions or a
critical approval such as `merge_policy: prompt`, push/PR, force-discard,
destructive migration/data loss, secrets/deployment/external side effects, or a
material scope change.

## Next

```bash
nexus project-init
nexus run init --run-id demo
nexus estimate --tasks 3
nexus plan-check --json
```

See [docs/workflow.md](../docs/workflow.md) and the repository README.
