# OpenCode Nexus

OpenCode Nexus is a dependency-light, multi-platform workflow for reliable agent-assisted development. It keeps planning, run state, handoffs, blast reports, and verification artifacts under `.opencode/`, while Graphify owns the repository graph in its native `graphify-out/` directory.

Nexus uses one canonical V3 workflow. The installer provides host-specific adapters for OpenCode, Claude Code, Cursor, Codex, Gemini CLI, and Antigravity.

## Canonical workflow

The canonical roster is:

| Agent | Responsibility |
|---|---|
| `orchestrator` | Routes the workflow, owns state transitions, and dispatches work |
| `implementer` | Implements one task or execution unit and runs verification |
| `unified-reviewer` | Reviews low- and medium-risk work in one pass |
| `spec-reviewer` | Checks high-risk scope, acceptance criteria, and callers |
| `code-reviewer` | Checks quality, security, and regressions after spec approval |
| `reconciler` | Recovers stale plans and blocked runs |

`blast-analyzer` is an optional compatibility agent. It is not installed by default; use Graphify and `scripts/nexus-blast.js` instead. Install it only when a host requires the legacy entry point:

```bash
./install.sh --with-optional-agents
```

The normal flow is:

```text
request → classify → plan → graph → blast → implement → review → reconcile/finish
```

Only the implementer writes production code. Review policy is selected by the V3 profile and change class:

| Profile | Branching | Review shape |
|---|---|---|
| `fast` | One feature/request branch | Unified review or skip for documentation |
| `balanced` (default) | One feature/execution-unit branch | Risk-based review |
| `strict` | One task branch | Spec review, then code review |

High-risk work (security, migration, public API, credentials, or HIGH blast) uses dual review even when the selected profile is otherwise faster.

## Install

### Prerequisites

| Requirement | Required for |
|---|---|
| Bash, Git | installer and branch workflows |
| [Node.js](https://nodejs.org/) | Nexus blast script and call estimator |
| [Graphify](https://github.com/Graphify-Labs/graphify) | directed repository graph, query/affected commands, refresh, and OpenCode integration |
| [`jq`](https://jqlang.org/) | OpenCode `opencode.json` merge; other adapters still install when `jq` is missing |
| [OpenCode](https://opencode.ai/docs/installation/) | optional — installer also supports Claude Code, Cursor, Codex, Gemini CLI, and Antigravity |
| `rg` / `fd` (optional) | faster general repository discovery |

Install `jq`:

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

Verify:

```bash
jq --version
```

Install `rg` ([ripgrep](https://github.com/BurntSushi/ripgrep)) and `fd` ([fd](https://github.com/sharkdp/fd)) — optional but recommended for repository discovery:

**Ubuntu / Debian / WSL:**

```bash
sudo apt update && sudo apt install -y ripgrep fd-find
# Debian/Ubuntu ship the fd binary as fdfind — scripts expect `fd`
command -v fd >/dev/null || sudo ln -sf "$(command -v fdfind)" /usr/local/bin/fd
```

**macOS (Homebrew):**

```bash
brew install ripgrep fd
```

**Fedora / RHEL:**

```bash
sudo dnf install -y ripgrep fd-find
command -v fd >/dev/null || sudo ln -sf "$(command -v fdfind)" /usr/local/bin/fd
```

**Windows (winget):**

```powershell
winget install BurntSushi.ripgrep.MSVC
winget install sharkdp.fd
```

Verify:

```bash
rg --version
fd --version
```

### One-command install

Clone and install (auto-detects installed platforms):

```bash
git clone https://github.com/mohammad154/opencode-nexus.git /tmp/opencode-nexus
cd /tmp/opencode-nexus && ./install.sh
```

Or run without cloning:

```bash
curl -fsSL https://raw.githubusercontent.com/mohammad154/opencode-nexus/main/install.sh | bash
```

If you already have the repository, run from the project root:

```bash
./install.sh
```

The installer is idempotent — re-run `./install.sh` to update after pulling changes.

`--only` is a strict allowlist. With no allowlist, the installer writes only to independently detected platform locations. Project-local outputs (`.cursor/rules/`, `.agents/`, etc.) are written only when the current directory is a Git repository — run the installer from the intended project when those outputs are desired.

The installer auto-detects platforms and writes host-specific artifacts:

- **OpenCode** (`~/.config/opencode/`): agents, `opencode.json` merge, model overrides
- **Claude Code** (`~/.claude/agents/nexus-*.md`, `~/.claude/skills/nexus-*/`)
- **Cursor** (`~/.cursor/agents/`, `~/.cursor/rules/`, `~/.cursor/skills/` + project `.cursor/rules/`)
- **Codex** (`~/.codex/agents/`, `~/.codex/skills/`, `~/.agents/skills/`)
- **Gemini CLI** (`~/.gemini/agents/`, `~/.gemini/skills/`, `~/.agents/skills/`)
- **Antigravity** (`~/.antigravity/`, `~/.gemini/config/skills/`, project `.agents/`)

See [`.opencode/INSTALL.md`](.opencode/INSTALL.md) for the full platform table, verification steps, and V3 workflow notes.

### Install specific adapters

```bash
./install.sh --only opencode
./install.sh --only claude,cursor
./install.sh --only codex
./install.sh --only gemini
./install.sh --only antigravity
./install.sh --all   # force all platforms even when binaries are not detected
```

Optional compatibility agent (`blast-analyzer`) — Graphify is the sole graph provider:

```bash
./install.sh --with-optional-agents
./install.sh --only opencode --with-optional-agents
```

### Uninstall

```bash
./uninstall.sh --only cursor
./uninstall.sh --all
./install.sh --uninstall   # delegates to uninstall.sh
```

Global one-liner:

```bash
git clone https://github.com/mohammad154/opencode-nexus.git /tmp/opencode-nexus
cd /tmp/opencode-nexus && ./uninstall.sh && rm -rf /tmp/opencode-nexus
```

## Adapter contract

The workflow, canonical agent names, review policy, handoff schemas, and graph/blast formats are shared. Platform adapters translate only:

- host installation paths;
- frontmatter required by the host;
- the `nexus-` agent and skill prefix where required;
- host permission syntax; and
- host dispatch names.

Adapters do not define a second workflow or review policy. The canonical `nexus-using-nexus` skill and agent definitions remain the source of workflow behavior. OpenCode installation also invokes `graphify install --platform opencode` and `graphify opencode install`; Nexus never installs Graphify dependencies or accesses the network.

| Platform | Main outputs | Host translation |
|---|---|---|
| OpenCode | `~/.config/opencode/agents/*.md` and `opencode.json` | Native agent names; OpenCode permissions/config |
| Claude Code | `~/.claude/agents/nexus-*.md`, `~/.claude/skills/nexus-*/` | `name`, `description`, `tools`, and `nexus-` dispatch names |
| Cursor | `~/.cursor/agents/`, `~/.cursor/rules/`, `~/.cursor/skills/` | `.mdc` rules, frontmatter, and `nexus-` names |
| Codex | `~/.codex/agents/`, `~/.codex/skills/`, `~/.agents/skills/` | Skill/agent paths and `nexus-` names |
| Gemini CLI | `~/.gemini/agents/`, `~/.gemini/skills/`, `~/.agents/skills/` | Skill/agent paths and `nexus-` names |
| Antigravity | `~/.antigravity/`, `~/.gemini/config/skills/`, project `.agents/` | IDE paths, translated skills, and a thin dispatch entrypoint |

Project-local outputs are written only when the current directory is a Git repository. Run the installer from the intended project when those outputs are desired.

## Run the workflow

Initialize durable state and classify the request:

```bash
node scripts/nexus-run.js init --run-id demo
node scripts/nexus-classify.js --files 2 --lines 40 --class small-feature-with-tests --focused
node scripts/nexus-estimate-calls.js --tasks 3 --profile balanced
```

Prepare repository context before implementation:

```bash
graphify query "<architecture question>"
graphify affected "<node-or-file>" --depth 2
graphify update .
node scripts/nexus-blast.js --files path/to/changed-file.js --json
```

Use the workflow engine for transitions and handoff validation:

```bash
node scripts/nexus-run.js transition --to CLASSIFIED --json '{"classification":{}}'
node scripts/nexus-run.js status
node scripts/nexus-run.js validate-handoff \
  --role implementer \
  --file .opencode/handoffs/<run>-implementer.json
```

The exact transition sequence depends on the selected profile and whether the run is direct, delegated, or blocked. A stale or uncertain analysis must be verified before a direct path is allowed.

Handoffs use **schema_version `1.1`** (shared envelope: `run_id`, `unit_or_task`, `agent`, `base_commit`, `created_at`). Legacy `1.0`/`0.9` handoffs migrate as `legacy_unverified` and cannot satisfy completion gates. Only `classify --apply` may authorize `direct_eligible`; PR A direct mode is **existing-diff-only** (two-stage isolated worktree direct is planned for PR B). Graph/blast trust requires provider revalidation — caller-supplied `trusted: true` labels are not authoritative.

## Durable artifacts

Nexus stores workflow context in `.opencode/`:

- `runs/<run-id>/state.json` — durable state-machine state;
- `CONTEXT.md` — active profile, branch, and verification context;
- `plans/PLAN.md` and `tasks/` — plan and execution-unit details;
- `handoffs/` — implementer and reviewer results;
- `graphify-out/graph.json` — Graphify's native directed repository graph;
- `graphify-out/GRAPH_REPORT.md` — Graphify's human-readable report;
- `.opencode/blast/` — Nexus blast-radius reports;
- `.opencode/reconcile/` — Nexus reconcile reports; and
- `graphify-out/memory/` + `graphify-out/reflections/LESSONS.md` — Graphify outcome memory.

Use Graphify for graph/query/refresh operations and Nexus scripts for blast, call estimation, run gates, and branch cleanup. Do not dispatch an agent merely to perform deterministic repository operations.

## Customize OpenCode models

On the first OpenCode install, the installer creates:

```text
~/.config/opencode/nexus.models.example.json
```

Copy it, edit the canonical agent entries, and rerun the installer:

```bash
cp ~/.config/opencode/nexus.models.example.json ~/.config/opencode/nexus.models.json
./install.sh --only opencode
```

One-off model overrides are available through `NEXUS_*_MODEL` and the corresponding reasoning-effort variables.

## Verification

The repository currently defines these checks:

```bash
npm test
npm run test:install
bash scripts/test-install-only.sh
bash scripts/test-optional-agents.sh
bash scripts/test-adapter-contract.sh
bash -n install.sh uninstall.sh scripts/test-install-only.sh \
  scripts/test-optional-agents.sh scripts/test-adapter-contract.sh
```

`npm test` runs the Node test suites. `npm run test:install` runs the installer isolation and optional-agent checks, including all six adapter smoke tests. There are no separate build, lint, or typecheck scripts in `package.json`.

## Repository layout

```text
agents/                 canonical agent definitions
skills/                 canonical workflow skills
config/                 profiles and model defaults
scripts/                graph, blast, state, estimate, and verification tools
docs/workflow.md        V3 workflow reference
install.sh              six-platform adapter installer
uninstall.sh            matching adapter cleanup
```
