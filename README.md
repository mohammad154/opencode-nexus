# OpenCode Nexus

OpenCode Nexus is a dependency-light OpenCode workflow for reliable agent-assisted development. It keeps planning, run state, handoffs, blast reports, and verification artifacts under `.opencode/`, while Graphify owns the repository graph in its native `graphify-out/` directory.

Nexus uses one canonical V3 workflow and installs native OpenCode agents and plugin config.

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
npx @mohammad154/opencode-nexus@latest install --with-optional-agents
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

High-risk work (security, migration, public API, or credentials) uses the `strict` execution profile and dual review. HIGH blast always escalates review to dual; the execution profile is re-scored from Graphify impact so batching can remain `balanced` when that is still safe.

## Install

The unscoped npm name `opencode-nexus` belongs to a different project. This
package is `@mohammad154/opencode-nexus`.

### Prerequisites

| Requirement | Required for |
|---|---|
| Bash, Git | installer and branch workflows |
| [Node.js](https://nodejs.org/) | Nexus blast script and call estimator |
| [Graphify](https://github.com/Graphify-Labs/graphify) | directed repository graph, query/affected commands, refresh, and OpenCode integration |
| [`jq`](https://jqlang.org/) | OpenCode `opencode.json` merge |
| [OpenCode](https://opencode.ai/docs/installation/) | host for Nexus agents, plugin, and model config |
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

Install or update from npm (recommended):

```bash
npx @mohammad154/opencode-nexus@latest install
```

The same command updates an existing install. Optional compatibility agent:

```bash
npx @mohammad154/opencode-nexus@latest install --with-optional-agents
```

Or install the CLI globally:

```bash
npm install -g @mohammad154/opencode-nexus@latest
nexus install
```

Later:

```bash
npm update -g @mohammad154/opencode-nexus
nexus install
```

`nexus` never changes OpenCode config during `npm install`. Setup is always explicit: `nexus install`.

From a local clone:

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

The installer writes OpenCode artifacts to `~/.config/opencode/`: agents, `opencode.json` merge, and model overrides. See [`.opencode/INSTALL.md`](.opencode/INSTALL.md) for verification steps and V3 workflow notes.

Optional compatibility agent (`blast-analyzer`) — Graphify is the sole graph provider:

```bash
npx @mohammad154/opencode-nexus@latest install --with-optional-agents
# or, from a clone:
./install.sh --with-optional-agents
```

### Uninstall

```bash
npx @mohammad154/opencode-nexus uninstall
# or, if the CLI is installed globally:
nexus uninstall
npm uninstall -g @mohammad154/opencode-nexus
```

From a clone:

```bash
./uninstall.sh
./install.sh --uninstall   # delegates to uninstall.sh
```

## OpenCode install

The installer writes native OpenCode agent files and merges plugin/model config. Canonical agent names, review policy, handoff schemas, and graph/blast formats stay in the repository definitions. Installation also invokes `graphify install --platform opencode` and `graphify opencode install`; Nexus never installs Graphify dependencies or accesses the network.

| Output | Location |
|---|---|
| Agents | `~/.config/opencode/agents/*.md` (native names: `orchestrator`, `implementer`, …) |
| Plugin and models | `~/.config/opencode/opencode.json` |
| Optional model overrides | `~/.config/opencode/nexus.models.json` |

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
nexus install
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

`npm test` runs the Node test suites. `npm run test:install` runs the OpenCode installer isolation and optional-agent checks. There are no separate build, lint, or typecheck scripts in `package.json`.

## Repository layout

```text
agents/                 canonical agent definitions
skills/                 canonical workflow skills
config/                 profiles and model defaults
scripts/                graph, blast, state, estimate, and verification tools
bin/nexus.js            npm CLI (`nexus install|update|uninstall|doctor`)
docs/workflow.md        V3 workflow reference
install.sh              OpenCode installer
uninstall.sh            matching OpenCode cleanup
```
