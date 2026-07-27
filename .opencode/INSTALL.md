# Installing OpenCode Nexus V3

## Prerequisites

- `jq` recommended (for OpenCode path merging) – `sudo apt install jq` on Ubuntu/WSL, `brew install jq` on macOS. If missing, OpenCode path skips with warning; other platforms install via file drop.
- `node` recommended – precise graph edges + blast Mermaid output + cost estimator. Shell fallback still works without node (rg/fd accelerators optional).
- No Python/pip/tree-sitter required – by design dependency-light.

## Global installation (multi-platform auto-detect)

Run:

```bash
curl -fsSL https://raw.githubusercontent.com/mohammad154/opencode-nexus/main/install.sh | bash
```

Or clone + run:

```bash
git clone https://github.com/mohammad154/opencode-nexus.git /tmp/opencode-nexus && cd /tmp/opencode-nexus && ./install.sh && rm -rf /tmp/opencode-nexus
```

The installer auto-detects installed agent platforms and installs the right artifact for each:

- **OpenCode** (`~/.config/opencode/`): plugin entry in `opencode.json` without overwriting your existing config, agent defs in `agents/` (**8 agents**, including `unified-reviewer`), models merge from defaults + `nexus.models.json`, backups `*.bak.timestamp`.
- **Claude Code** (`~/.claude/skills/nexus-*/` + `~/.claude/agents/nexus-*.md`): one-level skill dirs + subagents. Graph refresh: run `scripts/install-git-hook.sh` inside a consumer repo.
- **Cursor** (`~/.cursor/rules/nexus-*.mdc` + agents): each Nexus skill as `.mdc` (`using-nexus` alwaysApply).
- **Codex** (`~/.codex/skills/nexus-*/` + `~/.agents/skills/`): skills for Codex CLI.
- **Gemini CLI** (`~/.gemini/skills/nexus-*/` + `~/.agents/skills/nexus-*/`): one-level skill dirs.
- **Antigravity** (`~/.gemini/config/skills/nexus-*/` + `.agents/rules/nexus.md` + `.agents/workflows/nexus.md`).
- **Scripts** – verified present: `nexus-graph.sh/.js`, `nexus-blast.sh/.js`, `nexus-branch-cleanup.sh`, `nexus-estimate-cost.js/.sh`.

### Install only specific platforms

```bash
./install.sh --only opencode
./install.sh --only claude,opencode
./install.sh --only cursor
./install.sh --all
```

## Workflow profiles (V3)

Default: **`balanced`**. Config: `config/default-workflow.json`, `config/workflow-profiles.json`. Details: `skills/orchestrating/profiles.md`.

| Profile | Review | Branch |
|---------|--------|--------|
| `fast` | unified or skip | per feature/request |
| `balanced` | risk-based | per feature / execution unit |
| `strict` | dual always | per task |

```bash
node scripts/nexus-estimate-cost.js --tasks 3 --profile balanced
```

## Verify post-install

```bash
./scripts/nexus-graph.sh
node ./scripts/nexus-blast.js --mermaid
node ./scripts/nexus-estimate-cost.js --tasks 3 --profile balanced

# OpenCode — bare agent ids + permission.task
ls ~/.config/opencode/agents/{orchestrator,implementer,unified-reviewer,spec-reviewer,code-reviewer}.md

# Claude
head -5 ~/.claude/agents/nexus-unified-reviewer.md   # must show name: nexus-unified-reviewer
test -f ~/.claude/skills/nexus-orchestrating/dispatch.md
test -f ~/.claude/skills/nexus-orchestrating/profiles.md

# Cursor
head -5 ~/.cursor/agents/nexus-unified-reviewer.md
test -d ~/.cursor/skills/nexus-orchestrating
```

### Review gates (profile-aware)

**Dual** (strict or high-risk):

```bash
jq -e '.verdict=="APPROVED"' .opencode/handoffs/<id>-spec-reviewer.json
jq -e '.verdict=="APPROVED"' .opencode/handoffs/<id>-code-reviewer.json
```

**Unified** (fast/balanced low–medium):

```bash
jq -e '.verdict=="APPROVED"' .opencode/handoffs/<id>-unified-reviewer.json
```

Name resolution + paths: `skills/orchestrating/dispatch.md`.

### Branch cleanup

```bash
bash scripts/nexus-branch-cleanup.sh --base <base> --out .opencode/handoffs/plan-cleanup.json <feature-branch>
```

## Customize models

OpenCode reads models from `~/.config/opencode/opencode.json` under `agent`.

Optional: create `~/.config/opencode/nexus.models.json` (see `nexus.models.example.json` after install) and re-run the installer. Include `unified-reviewer`:

```json
{
  "orchestrator": { "model": "anthropic/claude-sonnet-4-20250514" },
  "implementer": { "model": "openai/gpt-4.1", "reasoningEffort": "high" },
  "unified-reviewer": { "model": "opencode-go/deepseek-v4-pro", "reasoningEffort": "high" },
  "spec-reviewer": { "model": "opencode-go/deepseek-v4-pro", "reasoningEffort": "max" },
  "code-reviewer": { "model": "opencode-go/deepseek-v4-pro", "reasoningEffort": "max" },
  "blast-analyzer": { "model": "opencode/deepseek-v4-flash-free", "reasoningEffort": "medium" },
  "knowledge-graph": { "model": "opencode/deepseek-v4-flash-free", "reasoningEffort": "low" },
  "reconciler": { "model": "opencode-go/deepseek-v4-pro", "reasoningEffort": "max" }
}
```

## Uninstall (multi-platform)

```bash
./uninstall.sh
./uninstall.sh --only claude
./uninstall.sh --all
```

Project-local `.opencode/knowledge/` and `.opencode/handoffs/` are not touched by uninstall.

## Windows fallback (legacy)

If git-backed plugin installation has issues on Windows, add local path to `opencode.json` as before (see README Windows fallback section).

For Claude/Cursor on Windows, use WSL/Git Bash to run `install.sh`.
