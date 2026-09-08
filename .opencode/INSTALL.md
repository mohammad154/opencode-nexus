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

## Three invariants

1. Every request starts with brainstorming and a plan.
2. Every implementer call requires fresh impact analysis.
3. Every implementation must be approved by an independent reviewer.

## Next

```bash
nexus project-init
nexus run init --run-id demo
nexus estimate --tasks 3
nexus plan-check --json
```

See [docs/workflow.md](../docs/workflow.md) and the repository README.
