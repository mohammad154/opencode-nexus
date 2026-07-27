# OpenCode Nexus

OpenCode Nexus is a shareable multi-agent workflow plugin for OpenCode with strong context-preservation defaults, a lightweight knowledge graph (Graphify-inspired), blast-radius safety (CodeLookup-inspired), and improve-grade planning (shadcn/improve).

It ships **8 agents** and **10 skills** with recommended default models (fully customizable), **V3 workflow profiles** (`fast` / `balanced` / `strict`), and a **multi-platform installer** that auto-detects OpenCode, Claude Code, Cursor, Codex, and Gemini/Antigravity from one command.

## Agents

Nexus ships **8 agents**: one primary controller and seven specialized subagents. The orchestrator delegates work; only the implementer writes production code. Agent definitions live in [`agents/`](agents/).

```text
User request
     │
     ▼
orchestrator ──► classify profile (fast|balanced|strict)
     │           scripts: graph / blast / cost estimate / cleanup
     ▼
implementer (code on feature or task branch)
     │
     ├─ low/med ─► unified-reviewer
     └─ high/strict ─► spec-reviewer → code-reviewer
     │
     ▼
reconciler (when plans drift or tasks get BLOCKED)
```

| Agent | Type | Default model | Role |
|-------|------|---------------|------|
| `orchestrator` | primary | `opencode-go/minimax-m3` | Workflow controller – profiles, scripts-first graph/blast/cleanup, dispatches subagents |
| `implementer` | subagent | `opencode/deepseek-v4-flash-free` | Writes code, tests, commits (one task or one execution unit) |
| `unified-reviewer` | subagent | `opencode-go/deepseek-v4-pro` | Combined spec+quality review for fast/balanced low–medium risk |
| `knowledge-graph` | subagent | `opencode/deepseek-v4-flash-free` | Optional; prefer `scripts/nexus-graph.sh` (commit cache) |
| `blast-analyzer` | subagent | `opencode/deepseek-v4-flash-free` | Optional; prefer `scripts/nexus-blast.js` |
| `spec-reviewer` | subagent | `opencode-go/deepseek-v4-pro` | Dual-review stage 1 – acceptance + blast fidelity |
| `code-reviewer` | subagent | `opencode-go/deepseek-v4-pro` | Dual-review stage 2 – quality, security, regression |
| `reconciler` | subagent | `opencode-go/deepseek-v4-pro` | Drift recovery – verifies DONE, classifies BLOCKED |

### orchestrator

Primary workflow controller. Does **not** write production code (unless user explicitly requests direct implementation).

- Auto-routes Nexus skills; sets **`workflow_profile`** (`fast`|`balanced`|`strict`, default **balanced**)
- Shows cost estimate: `node scripts/nexus-estimate-cost.js --tasks N --profile <p>`
- Maintains `.opencode/plans/PLAN.md`, `.opencode/CONTEXT.md`, task files, execution-unit JSON
- Graph/blast via **scripts** (cache-by-commit); agents optional
- Dispatches implementer per task (`strict`) or per execution unit (`fast`/`balanced`)
- Review: dual (strict/high-risk), **unified-reviewer** (low/medium), or skip (docs-only fast) — see [`dispatch.md`](skills/orchestrating/dispatch.md)
- LESSONS via `lessonPolicy` (noteworthy-only vs every-task)
- Branch cleanup via `scripts/nexus-branch-cleanup.sh` (not an LLM dispatch)

See [`agents/orchestrator.md`](agents/orchestrator.md) and [`skills/orchestrating/profiles.md`](skills/orchestrating/profiles.md).

### implementer

Writes production code. One **task** (`strict`) or one **execution unit** (`fast`/`balanced`) per dispatch.

- Drift check before editing; returns `BLOCKED` on STOP
- Uses blast report for callers; reference-first reading
- Runs exact verification gates; commits on the assigned feature branch
- Returns `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, or `NEEDS_CONTEXT`

See [`agents/implementer.md`](agents/implementer.md).

### unified-reviewer

Combined spec + quality gate for **fast/balanced** low–medium risk work.

- Acceptance criteria + code quality + blast callers in one pass
- Escalates to dual review when change looks high-risk
- Writes `.opencode/handoffs/<id>-unified-reviewer.json`

See [`agents/unified-reviewer.md`](agents/unified-reviewer.md).

### knowledge-graph

Optional agent — **prefer** `bash scripts/nexus-graph.sh` (commit cache, `--force` to rebuild).

See [`agents/knowledge-graph.md`](agents/knowledge-graph.md).

### blast-analyzer

Optional agent — **prefer** `node scripts/nexus-blast.js --files ... --task <id> --mermaid`.

See [`agents/blast-analyzer.md`](agents/blast-analyzer.md).

### spec-reviewer

Dual-review stage 1: **did the implementer build the right thing?**

See [`agents/spec-reviewer.md`](agents/spec-reviewer.md).

### code-reviewer

Dual-review stage 2: **did they build it well?**

See [`agents/code-reviewer.md`](agents/code-reviewer.md).

### reconciler

Recovery and drift handler when plans go stale or tasks get blocked.

See [`agents/reconciler.md`](agents/reconciler.md).

### Default model tiers

| Tier | Agents | Rationale |
|------|--------|-----------|
| Coordination | `orchestrator` | Routing, profile selection, delegation |
| Fast / code | `implementer`, optional graph/blast scripts | Throughput; scripts avoid LLM for deterministic work |
| Review | `unified-reviewer` (medium effort); dual reviewers `max` for high-risk | Risk-tiered reasoning — see `config/workflow-profiles.json` modelTiers |
| Recovery | `reconciler` (`reasoningEffort: max`) | Drift / BLOCKED classification |

All models are fully customizable – see [Customize agent models](#customize-agent-models) below.

## Why this workflow (V3)

- **Profiles** trade assurance vs speed: `balanced` default; `strict` for security/migrations/public API/HIGH blast.
- Durable `.opencode/` artifacts survive compaction.
- **Scripts-first** for graph (commit cache), blast, branch cleanup, cost estimate.
- Feature or task branches with isolation recovery under strict.
- Risk-based review (unified or dual) instead of always paying two reviewers.
- Outcome memory with **noteworthy-only** writes under fast/balanced.
- Drift-resilient planning (plan_commit, STOP, reconcile).
- Multi-platform installer.

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
- **Claude Code** (`~/.claude/skills/nexus-*/` + `~/.claude/agents/nexus-*.md`): agents get Claude `name:` + `tools:` frontmatter (required by [sub-agents docs](https://code.claude.com/docs/en/sub-agents)). Optional graph refresh: `scripts/install-git-hook.sh`
- **Cursor** (`~/.cursor/rules/nexus-*.mdc` + `~/.cursor/skills/nexus-*/` + `~/.cursor/agents/nexus-*.md`): rules + [Agent Skills](https://cursor.com/docs/skills) + [subagents](https://cursor.com/docs/subagents) with `name:` frontmatter
- **Codex** (`~/.agents/skills/nexus-*/` primary per [Codex skills](https://developers.openai.com/codex/skills) + `~/.codex/skills/nexus-*/` compat)
- **Gemini CLI** (`~/.gemini/skills/nexus-*/` + `~/.agents/skills/nexus-*/`)
- **Antigravity** (`~/.gemini/config/skills/nexus-*/` universal + `~/.gemini/antigravity/skills/` + workspace `.agents/skills/`)

Scripts are always verified as present (`scripts/nexus-graph.sh`, `nexus-graph.js`, `nexus-blast.sh`, `nexus-blast.js`, `nexus-branch-cleanup.sh`, `nexus-estimate-cost.js`) – dependency-light, no pip.

### Install only specific platforms

```bash
./install.sh --only opencode
./install.sh --only claude,opencode
./install.sh --only cursor
./install.sh --all   # force even if binary not detected (still drops files)

`--only` is a **strict allowlist**: `--only opencode` never writes Claude/Cursor/Codex/Gemini/Antigravity paths.
Without `--only`, each **independently detected** platform is installed (Antigravity is detected only via `antigravity`/`agy` binaries or AG-specific dirs — not via `ag`, `gemini`, or bare `~/.gemini`).
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

Expected high-level flow (V3):

1. Brainstorming
2. Planning (improve-grade) – `.opencode/plans/PLAN.md` with drift SHA, file:line evidence, effort/confidence, STOP, verification gates, findings triage
3. Knowledge graph via script – `bash scripts/nexus-graph.sh` (commit cache)
4. Set `workflow_profile` (`fast`|`balanced`|`strict`, default **balanced**) + cost estimate
5. Per execution unit (`balanced`/`fast`) or per task (`strict`):
   a. Blast via `node scripts/nexus-blast.js` (unit or task)
   b. Feature/task branch from `base_branch`
   c. Drift check against `plan_commit`
   d. **Dispatch implementer** (orchestrator does not write production code unless CONTEXT has exact `execution_mode: direct`)
   e. Review per profile: unified-reviewer (low/medium) or dual spec→code (strict / high-risk); never self-review
   f. LESSONS via `outcome-memory` (noteworthy-only under fast/balanced)
   g. Merge per policy; checkpoint only when `execution_mode: checkpoint`
6. Repeat until all units/tasks complete
7. Reconcile (if drift or BLOCKED) – verify DONE, investigate BLOCKED, retire fixed-elsewhere
8. Plan-end cleanup: `bash scripts/nexus-branch-cleanup.sh` for merged/discarded branches (do **not** dispatch implementer solely to delete) + final LESSONS reflect when noteworthy

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
  - `orchestrating/` – profile-aware loop: blast → branch → drift → implementer → review (unified or dual) → LESSONS → script cleanup; includes `profiles.md`, `dispatch.md`
  - `reconcile/` – verify DONE, investigate BLOCKED, refresh drift, retire fixed-elsewhere (from shadcn/improve reconcile)
  - `outcome-memory/` – LESSONS.md with noteworthy-only / every-task policies
  - `using-nexus/` – bootstrap router (profiles + scripts-first)
  - `finishing-a-development-branch/` – merge/PR/keep/discard + script cleanup
- `config/`:
  - `default-workflow.json`, `workflow-profiles.json` – V3 profile defaults and review matrix
  - `default-models.json`, `models.example.json`
- `scripts/`:
  - `nexus-graph.sh` / `nexus-graph.js` – graph builder with commit cache
  - `nexus-blast.sh` / `nexus-blast.js` – blast radius
  - `nexus-branch-cleanup.sh` – guarded branch deletion (replaces LLM cleanup)
  - `nexus-estimate-cost.js` / `.sh` – pre-run call-count estimate
- `.opencode/plugins/nexus.js` – plugin hooks (config, bootstrap, compaction)
- `docs/workflow.md` – V3 workflow + profiles
- `install.sh` – multi-platform installer (includes `unified-reviewer`)
- `uninstall.sh` – multi-platform inverse
- `scripts/install-git-hook.sh` – optional post-commit graph refresh

## Acknowledgements (cross-pollinated)

This release borrows proven patterns from:

- [Graphify](https://github.com/Graphify-Labs/graphify) – multi-platform installer (one command detects agent and drops right artifact), outcome memory pattern (save-result/reflect → LESSONS.md), persistent queryable graph (graph.json + graph.html), EXTRACTED/INFERRED edge tagging.
- [shadcn/improve](https://github.com/shadcn/improve) – plan-as-product philosophy (single-skill auditable package), plan format improvements: file:line evidence, effort/confidence scoring, explicit STOP conditions, drift check via commit SHA, verification gates (exact commands + expected output), reconcile command (verify DONE, investigate BLOCKED, retire fixed-elsewhere).
- [CodeLookup](https://github.com/ZethRise/CodeLookup-Skill) – pre-implementation blast-radius check before implementer starts (static import graph + git diff → Mermaid flowchart of what change might break), agent action protocol (resolve dependents together, prevent broken commits).
