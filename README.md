# OpenCode Nexus

OpenCode Nexus is a shareable multi-agent workflow plugin for OpenCode with strong context-preservation defaults.

It provides four workflow agents with **recommended default models** (fully customizable):

| Agent | Default model | Notes |
|-------|---------------|-------|
| Orchestrator | `opencode-go/minimax-m3` | Primary controller |
| Implementer | `opencode/deepseek-v4-flash-free` | Subagent |
| Spec Reviewer | `opencode-go/deepseek-v4-pro` | Subagent |
| Code Reviewer | `opencode-go/deepseek-v4-pro` | Subagent |

## Why this workflow

- Prevents context loss with durable files under `.opencode/`
- Uses feature branches for precise review boundaries
- Enforces two-stage review per task: spec compliance, then code quality
- Keeps final branch integration as an explicit user decision

## Prerequisites

You must have OpenCode installed before installing this project.

- OpenCode install guide: [https://opencode.ai/docs/installation/](https://opencode.ai/docs/installation/)
- [`jq`](https://jqlang.org/) — a small command-line JSON processor. The installer uses it to merge the Nexus plugin entry into your existing `opencode.json` without overwriting your other settings.

### Install jq

**Ubuntu / Debian / WSL:**

```bash
sudo apt update && sudo apt install -y jq
```

**macOS (Homebrew):**

```bash
brew install jq
```

**Fedora / RHEL:**

```bash
sudo dnf install -y jq
```

**Windows (winget):**

```powershell
winget install jqlang.jq
```

**Windows (Chocolatey):**

```powershell
choco install jq
```

Verify installation:

```bash
jq --version
```

## One-command install

```bash
git clone https://github.com/mohammad154/opencode-nexus.git /tmp/opencode-nexus && cd /tmp/opencode-nexus && ./install.sh && rm -rf /tmp/opencode-nexus
```

This installer:

- Adds the Nexus plugin entry to `~/.config/opencode/opencode.json` without overwriting other config
- Merges agent model settings into `opencode.json` (customizable — see below)
- Copies Nexus agent definitions to `~/.config/opencode/agents/`
- Creates backups for existing Nexus agent files (`*.bak`)

## Customize agent models

Models are configured in `~/.config/opencode/opencode.json` under the `agent` key — that is what OpenCode reads at runtime.

`~/.config/opencode/nexus.models.json` is an optional **installer input file** only. When you run `install.sh`, it merges your choices from `nexus.models.json` into `opencode.json`. You do not need `nexus.models.json` if you edit `opencode.json` directly.

On first install, an example file is created at `~/.config/opencode/nexus.models.example.json`. Copy and edit it:

```bash
cp ~/.config/opencode/nexus.models.example.json ~/.config/opencode/nexus.models.json
```

Example `~/.config/opencode/nexus.models.json`:

```json
{
  "orchestrator": {
    "model": "anthropic/claude-sonnet-4-20250514"
  },
  "implementer": {
    "model": "openai/gpt-4.1",
    "reasoningEffort": "high"
  },
  "spec-reviewer": {
    "model": "opencode-go/deepseek-v4-pro"
  },
  "code-reviewer": {
    "model": "opencode-go/deepseek-v4-pro",
    "reasoningEffort": "max"
  }
}
```

Only include agents you want to override; omitted agents keep the bundled defaults.

Apply changes by re-running `./install.sh`.

### Environment variable overrides (optional)

You can also override models for a one-off install:

```bash
export NEXUS_ORCHESTRATOR_MODEL="anthropic/claude-sonnet-4-20250514"
export NEXUS_IMPLEMENTER_MODEL="opencode/deepseek-v4-flash-free"
export NEXUS_IMPLEMENTER_REASONING_EFFORT="max"
./install.sh
```

Supported variables:

- `NEXUS_ORCHESTRATOR_MODEL`
- `NEXUS_IMPLEMENTER_MODEL`, `NEXUS_IMPLEMENTER_REASONING_EFFORT`
- `NEXUS_SPEC_REVIEWER_MODEL`, `NEXUS_SPEC_REVIEWER_REASONING_EFFORT`
- `NEXUS_CODE_REVIEWER_MODEL`, `NEXUS_CODE_REVIEWER_REASONING_EFFORT`

You can also set models directly in `~/.config/opencode/opencode.json` under the `agent` key ([OpenCode agents docs](https://opencode.ai/docs/agents/)).

## One-command uninstall

```bash
git clone https://github.com/mohammad154/opencode-nexus.git /tmp/opencode-nexus && cd /tmp/opencode-nexus && ./uninstall.sh && rm -rf /tmp/opencode-nexus
```

## Usage

1. Restart OpenCode after install.
2. Select the **orchestrator** primary agent (Tab to switch agents).
3. Open a **git** project repository (`git init` if needed).
4. Describe what you want in plain language:

```text
Implement JWT authentication with tests.
```

You do **not** need to type `Use the orchestrating skill...` every time. The Nexus plugin injects `using-nexus` at session start, which instructs the orchestrator to automatically load the right skill (`brainstorming` → `writing-plans` → `orchestrating` → `finishing-a-development-branch`) based on your request.

Explicit skill invocation still works if you prefer it:

```text
Use the orchestrating skill to implement JWT authentication with tests.
```

### Included skills (auto-routed)

| Skill | When it triggers |
|-------|------------------|
| `using-nexus` | Injected at session start (bootstrap) |
| `brainstorming` | New feature, unclear requirements |
| `writing-plans` | Creating `.opencode/plans/PLAN.md` |
| `using-feature-branches` | Starting isolated task work |
| `orchestrating` | Executing plan tasks with subagents |
| `finishing-a-development-branch` | All tasks reviewed, choose merge/PR/keep/discard |

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

Reviewers evaluate exact changes with (base branch is detected dynamically — not always `main`):

```bash
git diff <base-branch>...feature/task-N-<slug>
```

Example when base branch is `main`:

```bash
git diff main...feature/task-N-<slug>
```

## Windows fallback

If git-backed plugin installation has issues on Windows, install package content locally and point OpenCode to it (pattern inspired by Superpowers).

**PowerShell:**

```powershell
npm install opencode-nexus@git+https://github.com/mohammad154/opencode-nexus.git --prefix "$env:USERPROFILE\.config\opencode"
```

**Git Bash:**

```bash
npm install opencode-nexus@git+https://github.com/mohammad154/opencode-nexus.git --prefix "$HOME/.config/opencode"
```

Then add this plugin entry in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["~/.config/opencode/node_modules/opencode-nexus"]
}
```

## Project layout

- `agents/` — agent permissions and prompts (models live in `opencode.json`)
- `config/default-models.json` — bundled default models for `install.sh`
- `config/models.example.json` — optional installer input template (`nexus.models.json`)
- `skills/` — reusable workflow skills and dispatch templates
- `.opencode/plugins/nexus.js` — plugin hooks (`config`, message bootstrap, compaction context)
- `install.sh`, `uninstall.sh` — global setup scripts
