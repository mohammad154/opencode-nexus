# Installing OpenCode Nexus V4

Nexus V4 has one evidence-driven workflow core and an OpenCode installer. The
core owns workflow states, the Impact Engine, verification gates, handoffs, and
review rules. The installer writes native OpenCode agents and merges
plugin/model config.

## Prerequisites

- `node` (≥20) for Impact Engine, verification, and the CLI
- `jq` for OpenCode configuration merging and uninstall cleanup
- `git` for change evidence, worktrees, and branch workflows

Graphify is **not** required at runtime.

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

Canonical agents:

`orchestrator`, `implementer`, `unified-reviewer`, `spec-reviewer`,
`code-reviewer`, `reconciler`, `diagnostician`, `integration-reviewer`.

## Project bootstrap

```bash
nexus project-init
```

Creates `.opencode/` (CONTEXT, plans, handoffs, runs).

## Impact analysis

```bash
nexus impact --json
nexus run transition --to IMPACT_READY
nexus run inspect --run-id <id>
```

## Uninstall

```bash
nexus uninstall
```

Removes Nexus agents/plugin entries. Project-local `.opencode/` is kept.
