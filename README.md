# OpenCode Nexus

OpenCode Nexus is a shareable multi-agent workflow plugin for OpenCode with strong context-preservation defaults, a lightweight knowledge graph (Graphify-inspired), blast-radius safety (CodeLookup-inspired), and improve-grade planning (shadcn/improve).

It ships **7 agents** and **10 skills** with recommended default models (fully customizable) and a **multi-platform installer** that auto-detects OpenCode, Claude Code, Cursor, Codex, and Gemini/Antigravity from one command.

## Agents

Nexus ships **7 agents**: one primary controller and six specialized subagents. The orchestrator delegates work; only the implementer writes production code. Agent definitions live in [`agents/`](agents/).

```text
User request
     │
     ▼
orchestrator ──► knowledge-graph (map codebase)
     │           blast-analyzer (per-task safety)
     ▼
implementer (code on feature branch)
     │
     ├──► spec-reviewer (did we build the right thing?)
     └──► code-reviewer (did we build it well?)
     │
     ▼
reconciler (when plans drift or tasks get BLOCKED)
```

| Agent | Type | Default model | Role |
|-------|------|---------------|------|
| `orchestrator` | primary | `opencode-go/minimax-m3` | Workflow controller – routes skills, dispatches subagents, never writes production code |
| `implementer` | subagent | `opencode/deepseek-v4-flash-free` | Writes code, tests, and commits on feature branches |
| `knowledge-graph` | subagent | `opencode/deepseek-v4-flash-free` | Builds `.opencode/knowledge/graph.json` and answers dependency queries |
| `blast-analyzer` | subagent | `opencode-go/deepseek-v4-pro` | Computes blast radius before each task (Mermaid + risk score) |
| `spec-reviewer` | subagent | `opencode-go/deepseek-v4-pro` | First review gate – acceptance criteria and blast scope fidelity |
| `code-reviewer` | subagent | `opencode-go/deepseek-v4-pro` | Second review gate – quality, security, blast regression, LESSONS |
| `reconciler` | subagent | `opencode-go/deepseek-v4-pro` | Drift recovery – verifies DONE tasks, classifies BLOCKED tasks |

### orchestrator

Primary workflow controller. Does **not** write production code.

- Auto-routes Nexus skills (`brainstorming`, `writing-plans`, `orchestrating`, etc.)
- Maintains `.opencode/plans/PLAN.md`, `.opencode/CONTEXT.md`, and task files
- Ensures knowledge graph exists before planning or dispatch
- Runs blast-radius analysis **before** every implementer dispatch
- Dispatches one implementer at a time with blast + graph + LESSONS context
- Enforces two-stage review: spec-reviewer → code-reviewer (both blast-aware)
- Writes LESSONS entries via `outcome-memory` after reviews pass
- Delegates to reconciler when implementer returns `BLOCKED` (drift STOP)
- At plan end: final reconcile + branch cleanup via implementer

See [`agents/orchestrator.md`](agents/orchestrator.md).

### implementer

The only agent that writes production code. Implements **one task** per dispatch.

- Runs drift check (`plan_commit` vs `HEAD`) before editing; returns `BLOCKED` on STOP
- Uses blast report to update direct callers when signatures change
- Runs exact verification gates from the task file (not prose like "run tests")
- Commits on the assigned feature branch: `[task-N] <title>: <what>`
- Returns `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, or `NEEDS_CONTEXT`
- Also handles **branch cleanup** when dispatched at plan completion (deletes merged/discarded branches)

See [`agents/implementer.md`](agents/implementer.md).

### knowledge-graph

Builds a lightweight, dependency-free map of the codebase.

- Runs `scripts/nexus-graph.sh` / `nexus-graph.js`
- Produces `.opencode/knowledge/graph.json`, `graph.md`, `index.md`
- Tracks import edges (EXTRACTED vs INFERRED), hub nodes, language stats
- Answers ad-hoc queries ("who imports X?") via `jq` reverse index
- Never edits production code – only `.opencode/knowledge/`

See [`agents/knowledge-graph.md`](agents/knowledge-graph.md).

### blast-analyzer

Computes **blast radius** – what might break from a proposed change.

- Reads `graph.json` reverse index for the task's target files
- Outputs risk level (LOW / MEDIUM / HIGH), Mermaid diagram, and caller list
- Writes `.opencode/knowledge/blast/task-N.md` + `.json`
- Runs **before** implementer starts; HIGH risk triggers extra scrutiny in spec review
- Never edits production code

See [`agents/blast-analyzer.md`](agents/blast-analyzer.md).

### spec-reviewer

First review gate: **did the implementer build the right thing?** Read-only.

- Checks acceptance criteria with file:line evidence
- Verifies blast scope fidelity (callers updated when signatures change?)
- Detects out-of-scope changes and isolation violations
- Checks drift (does plan evidence still hold?)
- Returns `APPROVED`, `REQUEST_CHANGES`, `ISOLATION_VIOLATION`, or `BLOCKED`

See [`agents/spec-reviewer.md`](agents/spec-reviewer.md).

### code-reviewer

Second review gate: **did they build it well?** Read-only.

- Correctness, edge cases, security, maintainability
- Test quality; for MEDIUM/HIGH blast, checks caller-path coverage
- Blast regression check (callers still work?)
- LESSONS anti-pattern guard (`.opencode/knowledge/LESSONS.md`)
- Severity-tagged findings: HIGH / MEDIUM / LOW

See [`agents/code-reviewer.md`](agents/code-reviewer.md).

### reconciler

Recovery and drift handler when plans go stale or tasks get blocked.

- Verifies DONE tasks still hold after new commits
- Investigates `BLOCKED` tasks: `DRIFT_BLOCK`, `ENV_BLOCK`, `SCOPE_BLOCK`, `AUTH_BLOCK`
- Refreshes blast reports for remaining TODO tasks
- Retires findings fixed elsewhere (findings triage table in PLAN.md)
- Writes `.opencode/knowledge/reconcile-<timestamp>.md` and updates `CONTEXT.md`
- Never edits production code

See [`agents/reconciler.md`](agents/reconciler.md).

### Default model tiers

| Tier | Agents | Rationale |
|------|--------|-----------|
| Coordination | `orchestrator` (`minimax-m3`) | Routing, state management, multi-step delegation |
| Fast / code | `implementer`, `knowledge-graph` (`deepseek-v4-flash-free`) | Code generation and graph builds – higher throughput |
| Deep reasoning | `blast-analyzer`, `spec-reviewer`, `code-reviewer`, `reconciler` (`deepseek-v4-pro`, `reasoningEffort: max`) | Safety analysis, review, and drift recovery |

All models are fully customizable – see [Customize agent models](#customize-agent-models) below.

## Why this workflow (V2)

- Prevents context loss with durable files under `.opencode/` – survives compaction (plugin surfaces knowledge + LESSONS in `experimental.session.compacting`).
- Uses feature branches for precise review boundaries, with isolation recovery.
- **Graph before code**: lightweight knowledge graph (`graph.json` + `graph.md` + `index.md`) built via shell+optional node/jq (no Python/pip/tree-sitter) gives every agent a view of the whole project – hub/god nodes, importers, language breakdown.
- **Blast-before-implement**: every task pre-computes what callers might break via reverse dependency BFS (Mermaid diagram + LOW/MEDIUM/HIGH risk) – spec reviews catch scope creep early.
- Enforces two-stage review per task: spec compliance (file:line evidence, blast fidelity, STOP/drift) then code quality (severity tags, blast regression, LESSONS check).
- **Outcome memory**: `.opencode/knowledge/LESSONS.md` accumulates repo-specific anti-patterns across tasks (Graphify save-result/reflect pattern) so reviewers learn instead of starting cold.
- **Drift-resilient planning**: PLAN.md stamps git commit SHA; task files have STOP conditions, effort/confidence, verification gates, file:line evidence; `reconcile` verifies DONE still holds, investigates BLOCKED, retires fixed-elsewhere findings (shadcn/improve pattern).
- Keeps final branch integration as an explicit user decision. Multi-platform installer pattern borrowed from Graphify/CodeLookup.

## Prerequisites (light dependency)

| Requirement | Required for |
|-------------|--------------|
| [OpenCode](https://opencode.ai/docs/installation/) | primary platform, but not strictly required – other platforms supported via multi-platform installer |
| [`jq`](https://jqlang.org/) | recommended – installer uses it to merge plugin entry; if missing, OpenCode path skips gracefully, other platforms still install |
| `node` (optional but recommended) | precise graph edges (AST-lite regex) + blast script; shell fallback still works without it |
| `rg`/`fd` (optional, faster) | shell fallback graph + blast use rg for file discovery and caller grep if node missing |

Install jq:

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

Install `rg` ([ripgrep](https://github.com/BurntSushi/ripgrep)) and `fd` ([fd](https://github.com/sharkdp/fd)) — optional but recommended for faster file discovery and caller grep when `node` is missing:

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

## One-command install (multi-platform auto-detect)

```bash
git clone https://github.com/mohammad154/opencode-nexus.git /tmp/opencode-nexus && cd /tmp/opencode-nexus && ./install.sh && rm -rf /tmp/opencode-nexus
```

The installer auto-detects installed platforms and drops the right artifacts:

- **OpenCode** (`~/.config/opencode/`): plugin entry in `opencode.json`, agent defs in `agents/`, model merging, backup `*.bak.timestamp`
- **Claude Code** (`~/.claude/skills/nexus-*/` + `~/.claude/agents/nexus-*.md`): one-level skill dirs (Claude discovers `skills/<name>/SKILL.md` only). Optional graph refresh: `scripts/install-git-hook.sh` in a consumer repo
- **Cursor** (`~/.cursor/rules/nexus-*.mdc` + project `.cursor/rules/`): each skill as `.mdc` (`using-nexus` always-on; others agent-requested)
- **Codex** (`~/.codex/skills/nexus-*/`): skill bundle (recursive discovery)
- **Gemini CLI** (`~/.gemini/skills/nexus-*/` + `~/.agents/skills/nexus-*/`): one-level skill dirs (Gemini ignores nested `skills/nexus/<name>/`)
- **Antigravity** (`~/.gemini/config/skills/nexus-*/` + project `.agents/rules/nexus.md` + `.agents/workflows/nexus.md`): Graphify-compatible AG layout

Scripts are always verified as present (`scripts/nexus-graph.sh`, `nexus-graph.js`, `nexus-blast.sh`, `nexus-blast.js`) – dependency-light, no pip.

### Install only specific platforms

```bash
./install.sh --only opencode
./install.sh --only claude,opencode
./install.sh --only cursor
./install.sh --all   # force even if binary not detected (still drops files)
```

### Re-run / update

```bash
./install.sh   # idempotent, backs up agent files each time
```

### Uninstall

```bash
./install.sh --uninstall   # or ./uninstall.sh
./uninstall.sh --only claude
./uninstall.sh --all
```

Global one-liner uninstall:

```bash
git clone https://github.com/mohammad154/opencode-nexus.git /tmp/opencode-nexus && cd /tmp/opencode-nexus && ./uninstall.sh && rm -rf /tmp/opencode-nexus
```

## Customize agent models

Same as before – models in `~/.config/opencode/opencode.json` under `agent` key.

`~/.config/opencode/nexus.models.json` is an optional installer input. On first install, example created at `~/.config/opencode/nexus.models.example.json`.

```bash
cp ~/.config/opencode/nexus.models.example.json ~/.config/opencode/nexus.models.json
```

Example `nexus.models.json`:

```json
{
  "orchestrator": { "model": "anthropic/claude-sonnet-4-20250514" },
  "implementer": { "model": "openai/gpt-4.1", "reasoningEffort": "high" },
  "spec-reviewer": { "model": "opencode-go/deepseek-v4-pro" },
  "code-reviewer": { "model": "opencode-go/deepseek-v4-pro", "reasoningEffort": "max" },
  "blast-analyzer": { "model": "opencode-go/deepseek-v4-pro" },
  "knowledge-graph": { "model": "opencode/deepseek-v4-flash-free" },
  "reconciler": { "model": "opencode-go/deepseek-v4-pro" }
}
```

Apply by re-running `./install.sh`.

Environment variable overrides (one-off):

```bash
export NEXUS_ORCHESTRATOR_MODEL="anthropic/claude-sonnet-4-20250514"
export NEXUS_IMPLEMENTER_MODEL="opencode/deepseek-v4-flash-free"
./install.sh
```

Supported: `NEXUS_ORCHESTRATOR_MODEL`, `NEXUS_IMPLEMENTER_MODEL`, `..._REASONING_EFFORT` for implementer/spec/code.

## Usage

1. Restart your agent (OpenCode/Claude Code/Cursor) after install.
2. Open a **git** repo (`git init` if needed).
3. Describe what you want in plain language:

```text
Implement JWT authentication with tests.
```

You do not need to type `Use the orchestrating skill...` every time. The Nexus plugin injects `using-nexus` at session start, which instructs the orchestrator to automatically load the right skill based on phase and new V2 triggers (graph, blast, reconcile).

Explicit invocation still works:

```text
Use the orchestrating skill to implement JWT authentication with tests.
```

### Included skills (auto-routed, V2)

| Skill | When it triggers | Inputs / Outputs |
|-------|------------------|------------------|
| `using-nexus` | Injected at session start (bootstrap) | Router + Red Flags – points to right skill per phase |
| `brainstorming` | New feature, unclear requirements | Problem framing → handoff into writing-plans |
| `writing-plans` | Creating `.opencode/plans/PLAN.md` – now improve-grade | Outputs plan with file:line evidence, effort/confidence, STOP, drift SHA, verification gates, blast placeholders + per-task files following improved template |
| `knowledge-graph` | Need project-wide view, codebase map | `./scripts/nexus-graph.sh` → `.opencode/knowledge/graph.json` (EXTRACTED/INFERRED edges), `graph.md`, `index.md` with jq recipes |
| `blast-radius` | Before implementing target files – what breaks? | `node scripts/nexus-blast.js --files X --task N --mermaid` → blast MD + JSON (Mermaid diagram + risk LOW/MEDIUM/HIGH) |
| `using-feature-branches` | Starting isolated task work | Base branch detection, isolated/stacked policy, isolation recovery |
| `orchestrating` | Executing plan tasks | Per-task loop: blast → branch → drift check → implementer (with graph+blast+LESSONS) → spec-review (file:line + blast fidelity) → code-review (severity + blast regression + LESSONS) → LESSONS entry → checkpoint handling → cleanup |
| `reconcile` | Plan stale, BLOCKED tasks, before finishing, on drift | Verifies DONE still holds, classifies BLOCKED (DRIFT/ENV/SCOPE/AUTH), refreshes blast, retires fixed-elsewhere, writes reconcile report |
| `outcome-memory` | After each task review passes, at plan end, on "what have we learned?" | Appends repo-specific structured entries to `.opencode/knowledge/LESSONS.md` – pattern type, applicable when, recommendation file:line |
| `finishing-a-development-branch` | Per-task checkpoint or all tasks done | Presents merge/PR/keep/discard, records disposition, writes LESSONS entry, on plan end delegates cleanup + final LESSONS reflect |

Expected high-level flow (V2):

1. Brainstorming
2. Planning (improve-grade) – `.opencode/plans/PLAN.md` with drift SHA, file:line evidence, effort/confidence, STOP, verification gates, findings triage
3. Knowledge graph build (`.opencode/knowledge/graph.json` + `graph.md` + `index.md`)
4. Confirm workflow preferences (`branch_policy: isolated`, `execution_mode: checkpoint` recommended)
5. Per task:
   a. Blast-radius analysis → `.opencode/knowledge/blast/task-N.md` (Mermaid + risk + caller list)
   b. Branch creation from `base_branch` (when isolated)
   c. Drift check against `plan_commit`
   d. Implementer (with graph + blast + LESSONS context, STOP/respecting, verification gates)
   e. Spec review (file:line fidelity, blast scope fidelity)
   f. Code review (severity, blast regression, LESSONS anti-pattern guard)
   g. LESSONS.md entry via `outcome-memory`
   h. Per-task checkpoint: merge/PR/keep/discard + branch disposition note
6. Repeat until all tasks complete, building LESSONS along the way
7. Reconcile (if drift or BLOCKED) – verify DONE, investigate BLOCKED, retire fixed-elsewhere
8. Plan-end cleanup: orchestrator dispatches implementer to delete merged/discarded `feature/task-*` branches + final LESSONS reflect

### Knowledge graph usage (agents or manual)

```bash
# Build graph (command run by knowledge-graph skill)
./scripts/nexus-graph.sh .                           # whole repo
./scripts/nexus-graph.sh ./src                       # sub-path
node ./scripts/nexus-graph.js <file-list> . .opencode/knowledge/

# Outputs:
# .opencode/knowledge/graph.json    – machine-readable (nodes, EXTRACTED/INFERRED edges, confidence_score)
# .opencode/knowledge/graph.md      – summary (stats, languages, hub nodes)
# .opencode/knowledge/index.md      – wiki entrypoint with jq recipes

# Queries (jq – no embeddings, fast)
# Who imports auth.ts?
jq '.edges[] | select(.to | contains("auth"))' .opencode/knowledge/graph.json
# Top 10 most-imported files (in-degree)
jq -r '.edges | group_by(.to) | map({id:.[0].to,in:length}) | sort_by(-.in) | .[0:10][] | "\(.in) \(.id)"' .opencode/knowledge/graph.json
# Hub nodes (out-degree) – what everything else links through
jq -r '.edges | group_by(.from) | map({id:.[0].from,out:length}) | sort_by(-.out) | .[0:10][] | "\(.out) \(.id)"' .opencode/knowledge/graph.json
# Edges of a file
jq --arg f "src/auth/jwt.ts" '.edges[] | select(.from==$f or .to==$f)' .opencode/knowledge/graph.json
```

### Blast-radius usage (pre-implementation safety)

```bash
# Default: uses git diff against base or staged+untracked
node ./scripts/nexus-blast.js --mermaid

# Explicit file list with artifact for task 3
node ./scripts/nexus-blast.js --files src/auth/jwt.ts,src/middleware/auth.ts --task 3 --mermaid
# → .opencode/knowledge/blast/task-3.md + .json

# Who depends on this file?
node ./scripts/nexus-blast.js --explain src/auth/jwt.ts

# Deeper transitive search
node ./scripts/nexus-blast.js --depth 3 --files src/utils.ts --mermaid

# JSON only (for scripting)
node ./scripts/nexus-blast.js --json --files src/utils.ts

# Shell fallback (when node missing, uses rg heuristics)
./scripts/nexus-blast.sh --files src/x.ts --task 2
```

Output includes Mermaid flowchart `flowchart TD` with changed files in red, depth-1 dependents in yellow, deeper transitive in lighter yellow, risk level, and implementer guidance (HIGH → split task / expand scope, MEDIUM → add tests for caller paths, LOW → safe but still verify).

### Outcome memory (LESSONS.md)

After each task's reviews both APPROVED, orchestrator writes structured entry to `.opencode/knowledge/LESSONS.md`:

- Branch, base, plan_commit, blast risk + score + caller count
- Changed files with file:line
- Review notes from spec + code reviewer
- Lesson paragraph: pattern/anti-pattern/gotcha/constraint/verification type, "applicable when" condition, actionable recommendation (file:line)

Future tasks, spec-reviewers, code-reviewers read LESSONS to avoid repeating mistakes. See `skills/outcome-memory/SKILL.md` for template + example + reflect/compact procedure. Plugin surfaces LESSONS tail in session compaction context.

### Drift check + reconcile (from shadcn/improve)

Every PLAN.md is stamped with git commit SHA it was written against. Executors run:

```bash
git rev-parse --short HEAD    # compare to plan_commit in PLAN.md/CONTEXT.md
```

If drift > 50 commits or target file:line missing, STOP and call `reconcile`:

- Verify DONE tasks still hold (file:line evidence, verification gates)
- Investigate BLOCKED tasks (classify DRIFT_BLOCK, ENV_BLOCK, SCOPE_BLOCK, AUTH_BLOCK) and attempt auto-recovery via rg
- Refresh remaining TODO blast reports with fresh graph
- Retire findings fixed elsewhere (findings triage table in PLAN.md)
- Write `.opencode/knowledge/reconcile-<timestamp>.md` + update CONTEXT.md `reconcile` block

Run explicitly: "reconcile the plan" → auto-loads reconcile skill.

### Verification gates (improve-grade)

Every task in new template has verification gates with **exact commands + expected output**, not prose like "works correctly." Example:

```markdown
## Verification gates
1. `npm run build` – expected: exits 0
2. `npm test -- src/auth/jwt.test.ts` – expected: 8 passing
3. `git diff main...feature/task-1-jwt --stat` – only expected files changed
```

Implementer's handoff JSON now includes `verification_gates: [{cmd, expected, actual, pass}]` + `drift_check:{plan_commit,current_head,pass}` + `blast:{risk,verified,callers_checked[]}` – reviewable by both reviewers.

## Context preservation design

The workflow persists state in files so subagents do not rely only on transient chat context:

- `.opencode/plans/PLAN.md` – now with plan_commit SHA, findings triage (effort/confidence), verification_baseline, drift note
- `.opencode/CONTEXT.md` – now with plan_commit, verification_baseline, reconcile block
- `.opencode/tasks/task-N.md` – now with effort/confidence, STOP, blast radius section, graph insight, LESSONS ref, verification gates (exact commands)
- `.opencode/handoffs/task-N-<role>.json` – now includes plan_commit, drift_check, blast, verification_gates, findings with file:line
- `.opencode/knowledge/` (new, V2):
  - `graph.json` – dependency graph (versioned, nodes, EXTRACTED/INFERRED edges, confidence_score, stats)
  - `graph.md` – human summary: stats, language breakdown, hub nodes, how-to-use
  - `index.md` – wiki entrypoint for agents with jq recipes + file list
  - `blast/task-N.md` + `.json` – per-task blast report (Mermaid diagram + risk LOW/MEDIUM/HIGH)
  - `LESSONS.md` – outcome memory: structured entries (branch, blast, changed file:line, review notes, Lesson type/applicable/recommendation)
  - `reconcile-<timestamp>.md` – reconcile report (drift level, DONE verified, BLOCKED classified, retired findings)
- `.opencode/knowledge/` is git-ignored-friendly but durable across sessions – plugin surfaces its tail in compaction context so long-running sessions don't lose failure memory.

Workflow preferences in `.opencode/CONTEXT.md`:

- `branch_policy: isolated` – each task branches off `base_branch` (recommended)
- `execution_mode: checkpoint` – pause after each task for inspect/merge (recommended)
- `reconcile.at`, `drift_commits`, `drift_level` – when reconcile ran (new)

If a task branch inherits prior task commits, merge prior task to `base_branch` and rebase current branch before review. See [docs/workflow.md](docs/workflow.md).

Reviewers evaluate exact changes with (base branch dynamically detected):

```bash
git diff <base-branch>...feature/task-N-<slug>
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

Then add plugin entry in `~/.config/opencode/opencode.json`:

```json
{ "plugin": ["~/.config/opencode/node_modules/opencode-nexus"] }
```

For Claude Code / Cursor on Windows, use `install.sh` under WSL or Git Bash – it drops files into `%USERPROFILE%\.claude\`, `%USERPROFILE%\.cursor\`, etc.

## Support the project

If OpenCode Nexus is useful to you, subscribe to [OpenCode Go](https://opencode.ai/go?ref=KC87DT6PSB) with this referral link — referral link — we both get **$5** credit:

**https://opencode.ai/go?ref=KC87DT6PSB**

## Project layout (V2)

- `agents/` – agent permissions and prompts (orchestrator, implementer, spec-reviewer, code-reviewer, blast-analyzer, knowledge-graph, reconciler)
- `config/default-models.json` + `models.example.json` – bundled defaults + optional input template
- `skills/`:
  - `brainstorming/` – problem framing
  - `writing-plans/` – improve-grade: PLAN.md with effort/confidence, STOP, drift SHA, verification gates, file:line evidence, findings triage
  - `knowledge-graph/` – lightweight Graphify for agents (shell+node/jq, no python): build/query graph.json + wiki
  - `blast-radius/` – pre-implementation blast via nexus-blast.js (Mermaid + risk)
  - `using-feature-branches/` – branch policy + isolation recovery
  - `orchestrating/` – per-task loop: blast → branch → drift → implementer (graph+blast+LESSONS) → reviews (blast fidelity + LESSONS guard) → LESSONS entry
  - `reconcile/` – verify DONE, investigate BLOCKED, refresh drift, retire fixed-elsewhere (from shadcn/improve reconcile)
  - `outcome-memory/` – LESSONS.md pattern from Graphify save-result/reflect
  - `using-nexus/` – bootstrap router (auto-loads right skill per phase, multi-skill awareness)
  - `finishing-a-development-branch/` – merge/PR/keep/discard + disposition + LESSONS capture + plan-end cleanup delegation
- `scripts/`:
  - `nexus-graph.sh` – shell+optional node graph builder → `.opencode/knowledge/graph.json` + `graph.md` + `index.md`
  - `nexus-graph.js` – precise extractor (called inside shell script when node present)
  - `nexus-blast.sh` – shell fallback blast (rg heuristics)
  - `nexus-blast.js` – precise blast (reverse index BFS, Mermaid, risk scoring, --task artifact)
- `.opencode/plugins/nexus.js` – plugin hooks (config, bootstrap injection with V2 marker, compaction context surfacing graph.md + LESSONS tail + last reconcile)
- `docs/workflow.md` – workflow diagram + graph/blast/reconcile/LESSONS integration notes
- `install.sh` – multi-platform auto-detect (OpenCode, Claude Code, Cursor, Codex, Gemini, Antigravity) – Graphify pattern, correct one-level skill dirs, `--only` filter, backup timestamps
- `uninstall.sh` – multi-platform inverse, same `--only`/`--all` filters
- `scripts/install-git-hook.sh` – optional post-commit graph refresh for consumer repos

## Acknowledgements (cross-pollinated)

This release borrows proven patterns from:

- [Graphify](https://github.com/Graphify-Labs/graphify) – multi-platform installer (one command detects agent and drops right artifact), outcome memory pattern (save-result/reflect → LESSONS.md), persistent queryable graph (graph.json + graph.html), EXTRACTED/INFERRED edge tagging.
- [shadcn/improve](https://github.com/shadcn/improve) – plan-as-product philosophy (single-skill auditable package), plan format improvements: file:line evidence, effort/confidence scoring, explicit STOP conditions, drift check via commit SHA, verification gates (exact commands + expected output), reconcile command (verify DONE, investigate BLOCKED, retire fixed-elsewhere).
- [CodeLookup](https://github.com/ZethRise/CodeLookup-Skill) – pre-implementation blast-radius check before implementer starts (static import graph + git diff → Mermaid flowchart of what change might break), agent action protocol (resolve dependents together, prevent broken commits).
