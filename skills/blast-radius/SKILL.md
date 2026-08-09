---
name: blast-radius
description: Use before implementing a task to compute what callers and dependents might break from the proposed change — outputs Mermaid blast diagram + risk scoring + caller list for spec-reviewer and code-reviewer (CodeLookup-inspired)
compatibility: opencode
---

# Blast Radius (CodeLookup-inspired pre-implementation safety check)

## Purpose

Before an implementer starts editing, warn what the target files' callers and transitive dependents are so spec reviews catch scope creep early (not after diff exists). Outputs a Mermaid diagram, risk level, and machine-readable json that slots directly into task-N.md.

From CodeLookup's pattern:
- Graphify's directed node-link graph (reuses `graphify-out/graph.json` when present)
- Git diff target when not explicit
- BFS reverse dependency trace (depth configurable, default 2)
- Mermaid "blast radius" output
- Agent action protocol: resolve dependents together, prevent broken commits

## When to run

- Automatically before each implementer dispatch:
  - `strict`: once per task
  - `fast`/`balanced`: once per **execution unit** (recompute if scope expands)
- Prefer `node scripts/nexus-blast.js` over the blast-analyzer agent.
- Manually when user asks "what will break if I change X?"
- In reviewers when verifying caller handling.

## Commands

```bash
# Default: diff base...HEAD (or staged + untracked if no feature branch)
./scripts/nexus-blast.sh                            # shell wrapper (rg heuristics)
node ./scripts/nexus-blast.js                       # full version (graph + Mermaid + JSON)

# Explicit file list:
node ./scripts/nexus-blast.js --files src/auth/jwt.ts,src/middleware/auth.ts --mermaid

# For a specific task with artifact persistence:
node ./scripts/nexus-blast.js --task 3 --files src/auth/jwt.ts --mermaid
# → writes .opencode/blast/task-3.md + .json

# Deeper search:
node ./scripts/nexus-blast.js --depth 3 --files src/utils.ts

# Who depends on this file? (explain mode – no diff, single file focus)
node ./scripts/nexus-blast.js --explain src/auth/jwt.ts

# JSON output only (for scripting):
node ./scripts/nexus-blast.js --json --files src/utils.ts

# Override base branch for diff:
node ./scripts/nexus-blast.js --base main --mermaid

# Shell fallback when node unavailable:
./scripts/nexus-blast.sh --task 2
```

## Output formats

### Human markdown (default)

Written to stdout and (when --task given) `.opencode/blast/task-N.md`:

```markdown
# Blast Radius – risk: MEDIUM (score 8)

Changed files (2):
- src/auth/jwt.ts
- src/middleware/auth.ts

2 downstream file(s) may be affected:
| File | Depth | Via |
|------|-------|-----|
| src/api/routes/user.ts | 1 | src/auth/jwt.ts → src/api/routes/user.ts |
| src/api/routes/admin.ts | 2 | src/auth/jwt.ts → src/api/routes/user.ts → src/api/routes/admin.ts |

## Mermaid (blast radius diagram)

[mermaid diagram – see below]

## Implementer guidance
- MEDIUM risk: some callers – verify callers still behave, add tests for caller paths.
- Review diff with: git diff <base>...feature/task-N-<slug>
```

### Mermaid (via --mermaid)

```mermaid
flowchart TD
  n0_jwt["jwt.ts<br/>src/auth/jwt.ts"]
  style n0_jwt fill:#ff6b6b,stroke:#c92a2a,color:#fff
  n1_user["user.ts"]
  style n1_user fill:#ffd43b,stroke:#e67700
  n2_admin["admin.ts"]
  style n2_admin fill:#ffe066,stroke:#f59f00
  n0_jwt --> n1_user
  n1_user --> n2_admin
```

### JSON (via --json or after markdown separated by ---JSON--- marker)

```json
{
  "files": ["src/auth/jwt.ts"],
  "level": "MEDIUM",
  "score": 8,
  "impacts": [{"file":"src/api/routes/user.ts","depth":1,"via":["src/auth/jwt.ts","..."],"direct":true}],
  "edges": [{"from":"src/auth/jwt.ts","to":"src/api/routes/user.ts","depth":1}]
}
```

### Artifacts (when --task N)

- `.opencode/blast/task-N.md` – full markdown + mermaid
- `.opencode/blast/task-N.json` – pure JSON (machine-readable)

## Risk scoring

- Direct dependent (depth 1): +3 to score
- Transitive depth 2: +2
- Transitive depth 3+: +1
- LOW: score <5 and <3 impacted files
- MEDIUM: score 5-14 or 3-9 impacted files
- HIGH: score ≥15 or ≥10 impacted files, or signature change detected near many importers

Risk drives reviewer behavior:
- LOW → proceed, but run task tests
- MEDIUM → spec-reviewer must verify related callers section of task file, add tests for caller paths
- HIGH → flag to orchestrator to consider splitting task, expanding scope in writing, or discussing with user before implementer starts

## How Graphify improves blast

- If `graphify-out/graph.json` is fresh and directed, blast uses Graphify's exact reverse relations (`imports`, `calls`, `references`, `inherits`, `uses`, and related forms).
- If missing or stale, the script asks Graphify to run `graphify extract . --code-only --directed --no-viz` or `graphify update .` and reports UNKNOWN when trusted evidence is unavailable.
- No filename or `rg` heuristic is used to infer a LOW result.

## Integration points

- writing-plans: task-N.md must include "Related callers (blast)" section – populated either from a fresh directed Graphify run or placeholder "no directed Graphify graph yet, run graphify update / nexus-blast.js --task N".
- orchestrating:
  - Step 2 of per-task loop runs `node scripts/nexus-blast.js --files <csv> --task N --mermaid` before dispatch
  - Pastes blast markdown into task file or attaches as context
  - If blast HIGH, flags to spec-reviewer to watch scope creep
  - If new callers discovered after graph re-run, updates task-N.md Knowledge section
- implementer:
  - Required reading includes blast report
  - Must ensure callers listed still work (via tests or manual evidence)
  - If signature change, update callers listed in blast or document required follow-up with task link
- spec-reviewer and code-reviewer:
  - Required reading includes blast report
  - Verify callers handling (spec-reviewer: scope fidelity, code-reviewer: regression)
- outcome-memory: blast risk and callers recorded in LESSONS entry

## Troubleshooting

- Empty blast (no dependents)? Likely:
  - Target file is leaf module (no one imports it) – LOW risk, safe
  - Graph missing bare import edge due to barrel import or alias – re-run with shell fallback: `./scripts/nexus-blast.sh --files X`
  - Use explain mode to double-check: `node scripts/nexus-blast.js --explain src/foo.ts`
- Blast too noisy (100+ dependents)? File is god node (utils, constants, logger). For god nodes, orchestrator must recommend task split or note that all callers need lint-only check, not full test.
- graphify-out/graph.json stale? Run `graphify update .` to refresh before blast.

## Hard rules

- Never edit production code – only `.opencode/blast/*`
- Safe to re-run – overwrites existing blast report for same task number
- When Graphify is missing or cannot produce a directed fresh graph, degrade to UNKNOWN and log the reason.
- Blast output identifies Graphify as the provider and preserves relation names for reviewer traceability.
