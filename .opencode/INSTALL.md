# Installing OpenCode Nexus V2

## Prerequisites

- `jq` recommended (for OpenCode path merging) – `sudo apt install jq` on Ubuntu/WSL, `brew install jq` on macOS. If missing, OpenCode path skips with warning; other platforms install via file drop.
- `node` recommended – precise graph edges + blast Mermaid output. Shell fallback still works without node (rg/fd accelerators optional).
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

- **OpenCode** (`~/.config/opencode/`): plugin entry in `opencode.json` without overwriting your existing config, agent defs in `agents/` (now 7 agents), models merge from defaults + `nexus.models.json`, backups `*.bak.timestamp`.
- **Claude Code** (`~/.claude/skills/nexus-*/` + `~/.claude/agents/nexus-*.md`): one-level skill dirs + subagents. Graph refresh: run `scripts/install-git-hook.sh` inside a consumer repo (Claude has no post-commit hook event).
- **Cursor** (`~/.cursor/rules/nexus-*.mdc`): each Nexus skill as `.mdc` (`using-nexus` alwaysApply; others agent-requested via description).
- **Codex** (`~/.codex/skills/nexus-*/`): skills for Codex CLI.
- **Gemini CLI** (`~/.gemini/skills/nexus-*/` + `~/.agents/skills/nexus-*/`): one-level skill dirs (nested `skills/nexus/<name>` is not discovered).
- **Antigravity** (`~/.gemini/config/skills/nexus-*/` + `.agents/rules/nexus.md` + `.agents/workflows/nexus.md`): Graphify-compatible layout.
- **Scripts** – verified present: `scripts/nexus-graph.sh`, `nexus-graph.js`, `nexus-blast.sh`, `nexus-blast.js` – dependency-light, no pip.

Platform detection output example:

```
Platform detection:
  opencode: detected → will install
  claude: detected → will install
  cursor: not detected → will install   (when --all used; otherwise not)
  ...
```

### Install only specific platforms

```bash
./install.sh --only opencode              # only OpenCode (same as legacy)
./install.sh --only claude,opencode       # two platforms
./install.sh --only cursor
./install.sh --all                        # force even if binary not present
```

## Verify post-install

```bash
./scripts/nexus-graph.sh
node ./scripts/nexus-blast.js --mermaid

# OpenCode — bare agent ids + permission.task
ls ~/.config/opencode/agents/{orchestrator,implementer,spec-reviewer,code-reviewer}.md

# Claude — name: frontmatter required (docs: code.claude.com/docs/en/sub-agents)
head -5 ~/.claude/agents/nexus-spec-reviewer.md   # must show name: nexus-spec-reviewer
test -f ~/.claude/skills/nexus-orchestrating/dispatch.md

# Cursor — agents + skills (docs: cursor.com/docs/subagents + skills)
head -5 ~/.cursor/agents/nexus-code-reviewer.md   # must show name: nexus-code-reviewer
test -d ~/.cursor/skills/nexus-orchestrating

# Codex — USER skills at ~/.agents/skills (docs: developers.openai.com/codex/skills)
grep '^name:' ~/.agents/skills/nexus-orchestrating/SKILL.md   # name: nexus-orchestrating

# Gemini — ~/.gemini/skills or ~/.agents/skills
test -f ~/.gemini/skills/nexus-orchestrating/SKILL.md

# Antigravity — ~/.gemini/config/skills (+ ~/.gemini/antigravity/skills)
test -d ~/.gemini/config/skills/nexus-orchestrating
test -d ~/.gemini/antigravity/skills/nexus-orchestrating
```

### Two-stage review contract (every platform)

After implementer finishes task N, both must exist before finishing:

```bash
jq -e '.verdict=="APPROVED"' .opencode/handoffs/task-N-spec-reviewer.json
jq -e '.verdict=="APPROVED"' .opencode/handoffs/task-N-code-reviewer.json
```

Name resolution + paths: `skills/orchestrating/dispatch.md`.

## Customize models

OpenCode reads models from `~/.config/opencode/opencode.json` under `agent`.

Optional: create `~/.config/opencode/nexus.models.json` (see `nexus.models.example.json` after install) and re-run the installer to merge your choices into `opencode.json`. Example after V2 must include new agents:

```json
{
  "orchestrator": { "model": "anthropic/claude-sonnet-4-20250514" },
  "implementer": { "model": "openai/gpt-4.1", "reasoningEffort": "high" },
  "blast-analyzer": { "model": "anthropic/claude-sonnet-4-20250514" },
  "knowledge-graph": { "model": "openai/gpt-4.1-mini" },
  "reconciler": { "model": "opencode-go/deepseek-v4-pro" }
}
```

## Uninstall (multi-platform)

```bash
curl -fsSL https://raw.githubusercontent.com/mohammad154/opencode-nexus/main/uninstall.sh | bash
# or
./uninstall.sh                      # auto-detect + remove for installed platforms
./uninstall.sh --only claude        # only Claude Code
./uninstall.sh --all                # remove from all known platforms
```

Removes:

- OpenCode: plugin entry, agents (with backup restore when available), models.example.json – keeps `nexus.models.json` for reinstall
- Claude Code: `~/.claude/skills/nexus-*/` + `~/.claude/agents/nexus-*.md` (also removes obsolete `hooks/nexus-graph.json`)
- Cursor: `~/.cursor/rules/nexus-*.mdc`
- Codex: `~/.codex/skills/nexus-*/`
- Gemini: `~/.gemini/skills/nexus-*/` + `~/.agents/skills/nexus-*/`
- Antigravity: `~/.gemini/config/skills/nexus-*/` + project `.agents/rules|workflows/nexus.md`

Project-local `.opencode/knowledge/` and `.opencode/handoffs/` are not touched by uninstall (safe to keep or gitignore).

## Windows fallback (legacy)

If git-backed plugin installation has issues on Windows, add local path to `opencode.json` as before (see README Windows fallback section).

For Claude/Cursor on Windows, use WSL/Git Bash to run `install.sh` – it drops files into `%USERPROFILE%\.claude\`, `%USERPROFILE%\.cursor\` etc.
