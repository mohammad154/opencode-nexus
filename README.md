# OpenCode Nexus

<p align="center">
  <img src="./docs/assets/opencode-nexus-wordmark.svg" alt="OpenCode Nexus wordmark — plan, map, build, review" width="960">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mohammad154/opencode-nexus"><img src="https://img.shields.io/npm/v/%40mohammad154%2Fopencode-nexus?style=flat-square&label=npm" alt="npm package"></a>
  <a href="https://github.com/mohammad154/opencode-nexus/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/%40mohammad154%2Fopencode-nexus?style=flat-square" alt="MIT license"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A520-3c873a?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20 or newer"></a>
</p>

<p align="center"><strong>Fixed three-agent development workflow for <a href="https://opencode.ai">OpenCode</a>.</strong></p>

Nexus installs a predictable team into OpenCode: **orchestrator**, **implementer**, and **reviewer** — with the **Nexus Impact Engine**, TDD evidence, isolated worktrees, and durable run state under `.opencode/`.

```text
you describe the work
        ↓
orchestrator brainstorms → plans
        ↓
(for each task) pre-impact → implementer → post-impact + verify → reviewer
        ↓
REQUEST_CHANGES? → fresh pre-impact → implementer → reviewer (auto)
        ↓
final verify → finish
```

**Principle:** LLM proposes. Scripts measure. Tests prove. Independent reviewer approves. State machine decides.

**Three invariants:** (1) brainstorm + plan every request (2) fresh impact before every implementer (3) reviewer APPROVED every task.

Package: [`@mohammad154/opencode-nexus`](https://www.npmjs.com/package/@mohammad154/opencode-nexus) · Node 20+ · MIT

> The unscoped name `opencode-nexus` on npm is a **different** project. Always use `@mohammad154/opencode-nexus`.

---

## Contents

- [At a glance](#at-a-glance)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Use it](#use-it)
- [How the workflow works](#how-the-workflow-works)
- [Customize models](#customize-models)
- [Uninstall](#uninstall)
- [Verify / tests](#verify--tests)
- [Repository layout](#repository-layout)
- [Further reading](#further-reading)

---

## At a glance

Nexus gives OpenCode a repeatable delivery loop with explicit ownership and evidence at each handoff:

| Capability | What it adds |
|---|---|
| **Orchestration** | Fixed pipeline: brainstorm → plan → per-task impact/implement/review loop |
| **Impact mapping** | Built-in Nexus Impact Engine (git + AST + imports + tests) before every implementer |
| **Safe implementation** | Production edits only via implementer, with branch, worktree, and handoff context |
| **Always-on review** | Single `reviewer` on every task; auto fix-loop on REQUEST_CHANGES |
| **Durable state** | Stores plans, tasks, handoffs, impact reports, and run state so interrupted work can recover |

### Installed agents

After install, OpenCode has three canonical agents:

| Agent | Role |
|---|---|
| `orchestrator` | Owns the fixed workflow, plan, and task loop |
| `implementer` | Implements one task and verifies it |
| `reviewer` | Spec + correctness + quality + regression review every task |

Nexus also installs a plugin and model config, with the **Nexus Impact Engine** as the primary canonical evidence provider.

Plans, run state, handoffs, and impact reports live in `.opencode/`. Legacy Graphify repository graphs (if used) stay in `graphify-out/`.

---

## Quick start

Do this once on your machine, then open any project in OpenCode.

**1. Install the tools Nexus needs** (details in [Prerequisites](#prerequisites)):

- Node.js 20+, Git, Bash, [`jq`](https://jqlang.org/)
- [OpenCode](https://opencode.ai/docs/installation/)
- The **Nexus Impact Engine** is built-in and requires no external binaries.

**2. Install the Nexus CLI globally, then set up OpenCode:**

```bash
npm install -g @mohammad154/opencode-nexus@latest
nexus install
```

`npm install -g` only puts the `nexus` command on your machine (including `~/.local/bin` when npm's global prefix is not on `PATH`). Run `nexus install` afterward so OpenCode gets the agents and plugin.

If `nexus` is still not found, you do not need to edit `PATH` — this is equivalent:

```bash
npx @mohammad154/opencode-nexus@latest install
```

**3. Check that everything is in place:**

```bash
nexus doctor
```

**4. Restart OpenCode**, pick the **orchestrator** agent, and describe the change you want.

That is the normal path. The rest of this README is for setup details, profiles, and scripts.

---

## Prerequisites

### Required

| Tool | Why |
|---|---|
| [Node.js](https://nodejs.org/) 20+ | CLI, Nexus Impact Engine, state machine, call estimator |
| Bash | Installer (`Git Bash` or WSL on Windows) |
| Git | Branches, worktrees, change evidence |
| [`jq`](https://jqlang.org/) | Merges `opencode.json` on install/uninstall |
| [OpenCode](https://opencode.ai/docs/installation/) | Host for agents, plugin, and models |

**`jq`**

```bash
# Ubuntu / Debian / WSL
sudo apt update && sudo apt install -y jq

# macOS
brew install jq

# Fedora / RHEL
sudo dnf install -y jq

# Windows
winget install jqlang.jq
```

```bash
jq --version
```

### Optional (recommended)

- [Graphify](https://github.com/Graphify-Labs/graphify) (`graphify` on `PATH`): Optional repository visualization and graph exploration.
- `rg` ([ripgrep](https://github.com/BurntSushi/ripgrep)) and `fd` ([fd](https://github.com/sharkdp/fd)) speed up repository discovery.

```bash
# Ubuntu / Debian / WSL
sudo apt update && sudo apt install -y ripgrep fd-find
command -v fd >/dev/null || sudo ln -sf "$(command -v fdfind)" /usr/local/bin/fd

# macOS
brew install ripgrep fd

# Fedora / RHEL
sudo dnf install -y ripgrep fd-find
command -v fd >/dev/null || sudo ln -sf "$(command -v fdfind)" /usr/local/bin/fd

# Windows
winget install BurntSushi.ripgrep.MSVC
winget install sharkdp.fd
```

```bash
rg --version
fd --version
```

---

## Install

`npm install` never touches OpenCode config. Setup is always explicit: **`nexus install`**.

### Global CLI (recommended)

Install the `nexus` command once, then set up OpenCode:

```bash
npm install -g @mohammad154/opencode-nexus@latest
nexus install
nexus doctor
```

`npm install -g` never touches OpenCode config by itself. Always follow it with `nexus install`.

npm may install the binary under a custom prefix such as `~/.npm-global/bin`. After a global install, Nexus also links `nexus` and `opencode-nexus` into `~/.local/bin` so the command is available without extra PATH setup.

The same `nexus install` command **updates** an existing OpenCode setup.

Later:

```bash
npm update -g @mohammad154/opencode-nexus
nexus install
```

### From a local clone

```bash
./install.sh
```

The installer is idempotent — re-run `nexus install` or `./install.sh` to update.

Git clone fallback (if you are not using npm):

```bash
rm -rf /tmp/opencode-nexus &&
git clone --depth 1 https://github.com/mohammad154/opencode-nexus.git /tmp/opencode-nexus &&
cd /tmp/opencode-nexus &&
./install.sh &&
cd - >/dev/null &&
rm -rf /tmp/opencode-nexus
```

### What gets written

| Output | Location |
|---|---|
| Agents | `~/.config/opencode/agents/*.md` |
| Plugin + models | `~/.config/opencode/opencode.json` |
| Optional model overrides | `~/.config/opencode/nexus.models.json` |

Canonical agent files: `orchestrator`, `implementer`, `reviewer`.

On Windows, set `OPENCODE_CONFIG_DIR` if your OpenCode config is not under `~/.config/opencode`.

### Optional compatibility agent

V5 does not install optional agents. Nexus Impact Engine (`nexus impact`) covers git, AST, and affected test evidence.

```bash
nexus install --with-optional-agents
# from a clone:
./install.sh --with-optional-agents
```

A later `nexus install` (without the flag) removes leftover `blast-analyzer` config and agent files, including copies written by older Nexus releases. To keep it, pass `--with-optional-agents` again on that update.

To drop it explicitly:

```bash
nexus install --prune-optional-agents
```

Verification steps and notes: [`.opencode/INSTALL.md`](.opencode/INSTALL.md).

---

## Use it

1. Open your project in OpenCode.
2. Select the **orchestrator** agent.
3. Describe the change (feature, bugfix, refactor). The orchestrator classifies risk, plans, maps impact with the Nexus Impact Engine, then dispatches implementer and reviewers.

You usually do **not** need to run the scripts below by hand. They are the same gates the orchestrator uses.

### Workflow scripts (optional / debugging)

Initialize a run, classify, and estimate agent calls:

```bash
nexus project-init
nexus run init --run-id demo
nexus classify --files 2 --lines 40 --class small-feature-with-tests --focused
nexus estimate --tasks 3 --profile balanced
```

Impact analysis & baseline:

```bash
nexus impact --json
nexus baseline
nexus verify --baseline
```

State machine and handoff checks:

```bash
nexus run transition --to BRAINSTORMING
nexus run status
nexus run validate-handoff \
  --role implementer \
  --file .opencode/handoffs/<run>-implementer.json
```

The exact transition sequence depends on the profile and whether the run is direct, delegated, or blocked. A stale or uncertain analysis must be verified before a direct path is allowed.

Handoffs use **schema_version `1.1`** (shared envelope: `run_id`, `unit_or_task`, `agent`, `base_commit`, `created_at`). Legacy `1.0` / `0.9` handoffs migrate as `legacy_unverified` and cannot satisfy completion gates. Only `classify --apply` may authorize `direct_eligible`. Impact trust requires provider revalidation — a caller-supplied `trusted: true` label is not enough.

---

## How the workflow works

```text
request → classify → plan → impact → baseline → implement → review → final-verify → finish
                                       │
                                       └─ stale or blocked → reconcile
```

Only the **implementer** writes production code. Review shape comes from the profile and the change class:

| Profile | When | Branching | Review |
|---|---|---|---|
| `fast` | Tiny, low-risk, high-confidence | One branch per request | Unified review, or skip for docs |
| `balanced` (default) | Normal features | One branch per feature / execution unit | Risk-based |
| `strict` | Security, migration, public API, credentials | One branch per task | Spec review, then code review |

High-risk work always uses `strict` and dual review. A **HIGH** impact always escalates **review** to dual; the execution profile can stay `balanced` when impact analysis still says batching is safe.

UNKNOWN impact evidence never classifies as `fast`. Direct (no-dispatch) work is narrow: small, focused, low-risk, and high classifier confidence.

Full policy: [`docs/workflow.md`](docs/workflow.md).

### Where files land

| Path | What |
|---|---|
| `.opencode/runs/<run-id>/state.json` | Durable state-machine state |
| `.opencode/CONTEXT.md` | Active profile, branch, verification context |
| `.opencode/plans/PLAN.md` and `tasks/` | Plan and execution units |
| `.opencode/handoffs/` | Implementer and reviewer results |
| `.opencode/impact/` | Impact analysis reports |
| `.opencode/reconcile/` | Reconcile reports |
| `.opencode/memory/` + `reflections/LESSONS.md` | Outcome memory |

---

## Customize models

On first install, Nexus writes:

```text
~/.config/opencode/nexus.models.example.json
```

Copy it, edit the agent entries, then re-run install so they merge into `opencode.json`:

```bash
cp ~/.config/opencode/nexus.models.example.json ~/.config/opencode/nexus.models.json
# edit nexus.models.json
nexus install
```

One-off overrides (no file edit):

| Variable | Effect |
|---|---|
| `NEXUS_ORCHESTRATOR_MODEL` | Orchestrator model |
| `NEXUS_IMPLEMENTER_MODEL` | Implementer model |
| `NEXUS_UNIFIED_REVIEWER_MODEL` | Unified reviewer model |
| `NEXUS_SPEC_REVIEWER_MODEL` | Spec reviewer model |
| `NEXUS_CODE_REVIEWER_MODEL` | Code reviewer model |
| `NEXUS_IMPLEMENTER_REASONING_EFFORT` | Implementer reasoning effort |
| `NEXUS_UNIFIED_REVIEWER_REASONING_EFFORT` | Unified reviewer reasoning effort |
| `NEXUS_SPEC_REVIEWER_REASONING_EFFORT` | Spec reviewer reasoning effort |
| `NEXUS_CODE_REVIEWER_REASONING_EFFORT` | Code reviewer reasoning effort |

Example:

```bash
NEXUS_IMPLEMENTER_MODEL=anthropic/claude-sonnet-4-20250514 nexus install
```

---

## Uninstall

Removes Nexus agents and plugin entries. Graphify stays installed. Project-local `.opencode/` and `graphify-out/` data is left alone. Pre-existing OpenCode agent files are restored from installer backups when those backups exist.

```bash
nexus uninstall
npm uninstall -g @mohammad154/opencode-nexus
```

From a clone:

```bash
./uninstall.sh
# equivalent:
./install.sh --uninstall
```

---

## Verify / tests

```bash
nexus doctor
```

From a clone of this repo:

```bash
npm test
npm run test:install
```

`npm test` runs the Node test suites. `npm run test:install` runs installer isolation and optional-agent checks. There are no separate build, lint, or typecheck scripts.

Extra installer checks:

```bash
bash scripts/test-install-only.sh
bash scripts/test-optional-agents.sh
bash scripts/test-adapter-contract.sh
bash -n install.sh uninstall.sh scripts/test-install-only.sh \
  scripts/test-optional-agents.sh scripts/test-adapter-contract.sh
```

Confirm agents on disk:

```bash
ls ~/.config/opencode/agents/{orchestrator,implementer,reviewer}.md
```

---

## Repository layout

```text
agents/          canonical agent definitions
skills/          workflow skills the orchestrator loads
config/          profiles and model defaults
scripts/         impact, classify, state machine, estimate, cleanup
schemas/         handoff, impact, and run-state JSON schemas
bin/nexus.js     npm CLI: install | update | uninstall | doctor
docs/workflow.md V4 workflow reference
install.sh       OpenCode installer
uninstall.sh     matching cleanup
```

---

## Further reading

- [`.opencode/INSTALL.md`](.opencode/INSTALL.md) — installer behavior and verification
- [`docs/workflow.md`](docs/workflow.md) — profiles, gates, handoffs, and review policy
- [`docs/compatibility-v3.md`](docs/compatibility-v3.md) — legacy Graphify / V3 compatibility only
- [`skills/using-nexus/SKILL.md`](skills/using-nexus/SKILL.md) — how the orchestrator routes skills
- [OpenCode installation](https://opencode.ai/docs/installation/)
- [Graphify](https://github.com/Graphify-Labs/graphify)

---

## License

[MIT](LICENSE)
