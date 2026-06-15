# OpenCode Nexus

OpenCode Nexus is a shareable multi-agent workflow plugin for OpenCode with strong context-preservation defaults.

It implements:

- Orchestrator (`opencode-go/minimax-m3`)
- Implementer (`opencode/deepseek-v4-flash-free`, `reasoningEffort: max`)
- Spec Reviewer (`opencode-go/deepseek-v4-pro`, `reasoningEffort: max`)
- Code Reviewer (`opencode-go/deepseek-v4-pro`, `reasoningEffort: max`)

## Why this workflow

- Prevents context loss with durable files under `.opencode/`
- Uses feature branches for precise review boundaries
- Enforces two-stage review per task: spec compliance, then code quality
- Keeps final branch integration as an explicit user decision

## Prerequisites

You must have OpenCode installed before installing this project.

- OpenCode install guide: [https://opencode.ai/docs/installation/](https://opencode.ai/docs/installation/)
- `jq` is required by the installer to merge `opencode.json` safely

## One-command install

Replace `<YOUR-USERNAME>` with your GitHub username:

```bash
git clone https://github.com/<YOUR-USERNAME>/opencode-nexus.git /tmp/opencode-nexus && cd /tmp/opencode-nexus && ./install.sh && cd / && rm -rf /tmp/opencode-nexus
```

This installer:

- Adds the Nexus plugin entry to `~/.config/opencode/opencode.json` without overwriting other config
- Copies Nexus agent definitions to `~/.config/opencode/agents/`
- Creates backups for existing Nexus agent files (`*.bak`)

## One-command uninstall

```bash
git clone https://github.com/<YOUR-USERNAME>/opencode-nexus.git /tmp/opencode-nexus && cd /tmp/opencode-nexus && ./uninstall.sh && cd / && rm -rf /tmp/opencode-nexus
```

## Usage

1. Restart OpenCode after install.
2. Open a project repository.
3. Prompt with:

```text
Use the orchestrating skill to implement <feature> with tests.
```

Expected high-level flow:

1. Brainstorming
2. Planning (`.opencode/plans/PLAN.md`)
3. Task execution on feature branch
4. Spec review
5. Code-quality review
6. Finish branch (merge/PR/keep/discard)

## Context preservation design

The workflow persists state in files so subagents do not rely only on transient chat context:

- `.opencode/plans/PLAN.md`
- `.opencode/CONTEXT.md`
- `.opencode/tasks/task-N.md`
- `.opencode/handoffs/task-N-<role>.json`

Reviewers evaluate exact changes with:

```bash
git diff main...feature/task-N-<slug>
```

## Windows fallback

If git-backed plugin installation has issues on Windows, install package content locally and point OpenCode to it (pattern inspired by Superpowers):

```powershell
npm install opencode-nexus@git+https://github.com/<YOUR-USERNAME>/opencode-nexus.git --prefix "$HOME\.config\opencode"
```

Then add this plugin entry in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["~/.config/opencode/node_modules/opencode-nexus"]
}
```

## Project layout

- `agents/` - OpenCode markdown agent definitions
- `skills/` - reusable workflow skills and dispatch templates
- `.opencode/plugins/nexus.js` - plugin hooks (`config`, message bootstrap, compaction context)
- `install.sh`, `uninstall.sh` - global setup scripts