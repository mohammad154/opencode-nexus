---
name: knowledge-graph
description: Use to build, update, and query the codebase knowledge graph (.opencode/knowledge/graph.json) — a lightweight, dependency-light alternative to Graphify that gives agents a queryable map of the whole project. Run before planning or when codebase context is needed
compatibility: opencode
---

# Knowledge Graph (lightweight Graphify for Nexus)

## Purpose

Give every Nexus agent a better view of the whole project before acting — what everything connects through (god/hub nodes), what a change might break (blast radius), how the project is layered.

Inspired by Graphify (multi-platform knowledge graphs, EXTRACTED/INFERRED tagging, persistent graph.json, outcome memory, queryable edges), but built intentionally small:
- No Python, no pip, no tree-sitter — just shell + Node + jq (optional)
- Runs in <2s for small-mid projects (<2000 files)
- Outputs `.opencode/knowledge/` (graph.json, graph.md, index.md, blast/, LESSONS.md)
- Native jq recipes for agents (see index.md)

## When to run automatically

- **Before writing-plans**: ensure graph exists (script reuses unchanged file-hash results when safe).
- **Before execution** (orchestrating preamble): `bash scripts/nexus-graph.sh` — reuses cached results only when source file hashes, repository state, and extractor version are fresh.
- **Force rebuild**: `bash scripts/nexus-graph.sh --force` or `NEXUS_GRAPH_FORCE=1`.
- **Docs-only changes**: `bash scripts/nexus-graph.sh --docs-only-skip`.
- Prefer the **script** over dispatching the knowledge-graph agent.
- **On explicit user request**: "build graph", "show me project structure", "what depends on X?"
- **When drift HIGH**: re-run graph after reconcile (`--force` if needed).

## Commands

```bash
# Build / refresh full graph (primary — cache-by-file-hash/content)
./scripts/nexus-graph.sh [root] [out_dir]
./scripts/nexus-graph.sh --force
./scripts/nexus-graph.sh --docs-only-skip
# Example: ./scripts/nexus-graph.sh .                   → .opencode/knowledge/
# Example: ./scripts/nexus-graph.sh ./src                → ./src/.opencode/knowledge/ (not recommended – prefer project root)

# With node for richer edges (then auto-falls back to shell)
node ./scripts/nexus-graph.js <file-list> <root> <out_dir>
# Usually not called directly – invoked inside nexus-graph.sh when node available.

# Query helpers (jq)
# Who imports auth.ts?
jq '.edges[] | select(.to | contains("auth"))' .opencode/knowledge/graph.json

# Top 10 most-imported files (in-degree)
jq -r '.edges | group_by(.to) | map({id: .[0].to, in: length}) | sort_by(-.in) | .[0:10][] | "\(.in) \(.id)"' .opencode/knowledge/graph.json

# God/hub nodes (out-degree  – what everything else connects through)
jq -r '.edges | group_by(.from) | map({id: .[0].from, out: length}) | sort_by(-.out) | .[0:10][] | "\(.out) \(.id)"' .opencode/knowledge/graph.json

# Edges for a specific file
jq --arg f "src/auth/jwt.ts" '.edges[] | select(.from==$f or .to==$f)' .opencode/knowledge/graph.json

# List languages
jq -r '.nodes | group_by(.lang) | map("\(.[0].lang): \(length)")[] | .[]' .opencode/knowledge/graph.json
```

## Outputs

`.opencode/knowledge/`:
- `graph.json` – machine-readable, versioned: { version, root, generated_at, stats, nodes[], edges[] where edges tagged EXTRACTED/INFERRED + external boolean + confidence_score }
- `graph.md` – human summary: stats, language breakdown, hub nodes, how-to-use, graph freshness
- `index.md` – entry point for agents: file list, jq recipes, generation command, tip to run nexus-blast.js for impact analysis
- `blast/` – per-task blast-radius reports from nexus-blast.js (Mermaid + json)
- `LESSONS.md` – outcome memory (Graphify save-result/reflect pattern) – populated by orchestrating + outcome-memory skills
- `.files.tmp` – transient discovery cache (git-ignored friendly, overwritten each run)

## Edge taxonomy (borrowed from Graphify, adapted)

- confidence: EXTRACTED – explicit import found by parser (AST or regex with resolution success)
- confidence: INFERRED – import specifier is bare (npm/pip/external) or relative but resolution failed – still useful as dependency signal
- external boolean – true when bare specifier likely external (npm/pip) vs possibly internal alias

`| confidence | meaning | confidence_score | example |`
`|------------|---------|------------------|---------|`
`| EXTRACTED  | resolved file exists on disk | 1.0 | "./utils.ts" → "src/utils.ts" exists |`
`| INFERRED   | unresolved relative or alias | 0.75-0.9 | "@/components/button" or "./foo" not found |`
`| INFERRED   | external dep (bare) | 0.9 | "react", "lodash" – not local |`

When edge extraction is coarse (shell fallback), all edges are INFERRED with 0.5-0.75 scores – note this in graph.md.

## Integration with workflow

- writing-plans:
  - Prereq: run nexus-graph.sh before drafting plan so Context & Evidence can cite graph stats, hub nodes, top importers for target files
  - Task template must include "Graph insight" section backed by graph.json, not guesses
- orchestrating:
  - Runs graph build once before first task dispatch
  - For each task, runs blast script using graph to produce task-N.md blast report + Mermaid
  - Attaches blast report path to implementer + reviewers Required Reading
  - If graph timestamp > task file timestamp and target files unchanged, re-run blast (graph has evolved)
- reconcile:
  - When drift detected, re-run graph to get fresh evidence
  - Checks if target file:line moved and if new edges formed (hidden coupling discovered)

## Limitations (honest, like Graphify)

- Not AST = not 100% accurate – regex-based for speed + dependency-light; node path is precise but still not full tree-sitter
- External deps not pruned fully (heuristic skip list)
- Only dependency edges (imports), not call graphs or dataflow – sufficient for blast but not full program analysis
- No vector embeddings – use file paths + simple jq for queries
- For monorepo, pass root; do not run per package (will split graph)

## Troubleshooting

- No graph.json? → `./scripts/nexus-graph.sh` (needs bash, common coreutils)
- Empty graph? Tab switches? Node not available? upgradable by including fd and rg? Likely your .gitignore or large project; try with reduced depth: `fd --max-depth 3`
- Large project (>2000 files) → use fd filter or pass explicit file list via temporary .files.tmp
- graph.json too big for agent context window? JQ first: `jq '.stats' graph.json` or `jq '.nodes[0:30]' graph.json` – never cat full graph into prompt

## Hard rules

- Never mutate production code.
- Graph build is read-only on file system write except .opencode/knowledge/
- Safe to run repeatedly – deterministic given same repo state (timestamp only moves)
- Output is additive to workflow – writing-plans + orchestrating work even when graph.json missing (degrades gracefully, per-task blast falls back to rg Caller heuristics in shell)
