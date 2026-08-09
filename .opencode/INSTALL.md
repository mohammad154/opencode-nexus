# Installing OpenCode Nexus V3

Nexus V3 has one workflow core and six thin platform adapters. The core owns
workflow states, policy, handoffs, blast-report compatibility, and review rules;
adapters translate paths, frontmatter, names, permissions, and dispatch syntax.

## Prerequisites

- `node` for the Nexus blast script and call estimator.
- `graphify` for the directed repository graph and OpenCode integration. Nexus
  does not install Graphify or access the network.
- `jq` for OpenCode configuration merging and uninstall cleanup.
- `git` for change evidence, graph freshness, and branch workflows.

The installer remains dependency-light. Graphify is an external prerequisite.

## Install

Auto-detect supported platforms:

```bash
curl -fsSL https://raw.githubusercontent.com/mohammad154/opencode-nexus/main/install.sh | bash
```

Or clone and run locally:

```bash
git clone https://github.com/mohammad154/opencode-nexus.git /tmp/opencode-nexus
cd /tmp/opencode-nexus && ./install.sh
```

Install selected adapters only:

```bash
./install.sh --only opencode
./install.sh --only claude,opencode
./install.sh --all
```

For an OpenCode install, Nexus requires the Graphify CLI and invokes both
native integration commands:

```bash
graphify install --platform opencode
graphify opencode install
```

If `graphify` is unavailable, Nexus stops with a prerequisite message. Nexus
does not install Python packages, access the network, or remove Graphify during
uninstall.

## Platform support

| Platform | User adapter paths | Translation performed |
|---|---|---|
| OpenCode | `~/.config/opencode/` | Native agent names, plugin/config merge, permissions |
| Claude Code | `~/.claude/skills/nexus-*`, `~/.claude/agents/nexus-*` | Skill frontmatter, agent names, dispatch permissions |
| Cursor | `~/.cursor/rules/nexus-*`, `~/.cursor/agents/nexus-*` | Rule frontmatter, names, dispatch syntax |
| Codex | `~/.codex/skills/nexus-*`, `~/.agents/skills/nexus-*` | Skill paths and agent-name prefixes |
| Gemini CLI | `~/.gemini/skills/nexus-*`, `~/.agents/skills/nexus-*` | Skill paths and frontmatter names |
| Antigravity | `~/.gemini/config/skills/nexus-*`, project `.agents/` | Skill paths, rule/workflow entry points |

Every adapter installs the same six canonical agents:

`orchestrator`, `implementer`, `unified-reviewer`, `spec-reviewer`,
`code-reviewer`, and `reconciler`.

`blast-analyzer` remains an optional compatibility agent. Graphify is the sole
graph provider and the deterministic Nexus blast script is the default path:

```bash
./install.sh --only opencode --with-optional-agents
```

## V3 workflow and profiles

The default profile is `balanced`. Profiles are defined in
`config/workflow-profiles.json` and preserve hard review requirements for
security, migration, public API, credential, and high-blast changes. Direct
work is allowed only when repository-derived evidence and validation satisfy
the direct-path rules.

Estimate agent calls, not monetary spend:

```bash
node scripts/nexus-estimate-calls.js --tasks 3 --profile balanced
```

The runtime can enforce the same profile-derived call ceiling through the
provider telemetry budget interface. Hosts may provide a lower ceiling, never
a higher one. Metrics report actual calls, durations, cache hits, failures, and
tokens; a `cost_usd` field is retained only when the host supplies it.

## Verify graph and blast evidence

```bash
graphify query "<architecture question>"
graphify affected "<node-or-file>" --depth 2
node scripts/nexus-blast.js --mermaid
```

Graphify owns graph refresh and native metadata. Nexus requires a fresh directed
Graphify graph for trusted blast evidence. Missing, malformed, stale,
failed-refresh, or undirected graphs remain UNKNOWN.

Useful outputs live in Graphify's native `graphify-out/` and Nexus's `.opencode/`:

- `graph.json` — machine-readable directed Graphify graph;
- `GRAPH_REPORT.md` — Graphify's human-readable report;
- `memory/` and `reflections/LESSONS.md` — Graphify outcome memory;
- `.opencode/blast/` — per-task blast reports;
- `.opencode/reconcile/` — Nexus reconcile reports.

## Verify installation

```bash
npm test
npm run test:install
```

OpenCode agents use native names:

```bash
ls ~/.config/opencode/agents/{orchestrator,implementer,unified-reviewer,spec-reviewer,code-reviewer,reconciler}.md
```

Other adapters prefix installed agent and skill names with `nexus-` where the
host requires it. The installer tests exercise all six adapters in isolated
temporary homes, including repeated installation and uninstall cleanup.

## Customize models

OpenCode reads models from `~/.config/opencode/opencode.json` under `agent`.
Optional overrides can be placed in
`~/.config/opencode/nexus.models.json` and merged by rerunning the installer.

## Uninstall

```bash
./uninstall.sh
./uninstall.sh --only opencode
./uninstall.sh --only claude,cursor
./uninstall.sh --all
```

The uninstaller restores backed-up pre-existing adapter files where supported,
removes Nexus entries without removing unrelated user configuration, leaves
Graphify installed, and keeps project-local `graphify-out/`, `.opencode/blast/`,
`.opencode/reconcile/`, and `.opencode/handoffs/` data.
