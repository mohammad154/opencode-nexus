# OpenCode Nexus

OpenCode Nexus is a dependency-light, multi-platform workflow for reliable agent-assisted development. It keeps planning, run state, handoffs, graph/blast reports, and verification artifacts under `.opencode/` while using deterministic scripts for repository analysis and cleanup.

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

`knowledge-graph` and `blast-analyzer` are compatibility-only agents. They are not installed by default; use `scripts/nexus-graph.sh` and `scripts/nexus-blast.js` instead. Install them only when a host requires the legacy entry points:

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

Prerequisites are Bash, Git, and Node.js for the full script suite. `jq` is required for the OpenCode configuration merge; other adapters can still install when `jq` is unavailable.

Install detected platforms:

```bash
./install.sh
```

Install a specific adapter without touching the others:

```bash
./install.sh --only opencode
./install.sh --only claude,cursor
./install.sh --only codex
./install.sh --only gemini
./install.sh --only antigravity
./install.sh --all
```

`--only` is a strict allowlist. With no allowlist, the installer writes only to independently detected platform locations.

Uninstall with the matching scope:

```bash
./uninstall.sh --only cursor
./uninstall.sh --all
```

## Adapter contract

The workflow, canonical agent names, review policy, handoff schemas, and graph/blast formats are shared. Platform adapters translate only:

- host installation paths;
- frontmatter required by the host;
- the `nexus-` agent and skill prefix where required;
- host permission syntax; and
- host dispatch names.

Adapters do not define a second workflow or review policy. The canonical `nexus-using-nexus` skill and agent definitions remain the source of workflow behavior.

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

Build deterministic repository context before implementation:

```bash
bash scripts/nexus-graph.sh
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

## Durable artifacts

Nexus stores workflow context in `.opencode/`:

- `runs/<run-id>/state.json` — durable state-machine state;
- `CONTEXT.md` — active profile, branch, and verification context;
- `plans/PLAN.md` and `tasks/` — plan and execution-unit details;
- `handoffs/` — implementer and reviewer results;
- `knowledge/graph.json` — script-generated repository graph;
- `knowledge/blast/` — blast-radius reports; and
- `knowledge/LESSONS.md` — noteworthy, reusable outcomes.

Use scripts for graph, blast, call estimation, run gates, and branch cleanup. Do not dispatch an agent merely to perform deterministic repository operations.

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
