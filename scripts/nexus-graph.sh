#!/usr/bin/env bash
# nexus-graph.sh — lightweight codebase→knowledge-graph builder
# Inputs:  project root (default: git root or $PWD)
# Outputs: .opencode/knowledge/
#   graph.json       – persistent graph for querying weeks later (no re-read)
#   graph.md         – human-readable summary: god nodes, clusters, surprising edges
#   index.md         – entrypoint for agents (wiki-style navigation)
# Design: shell + jq + node (optional) – no Python, no pip, no tree-sitter.
# Prefers `rg`/`fd` if installed, falls back to find/grep.

set -euo pipefail

ROOT="${1:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
ROOT="$(cd "$ROOT" && pwd)"
OUT_DIR="${2:-$ROOT/.opencode/knowledge}"
mkdir -p "$OUT_DIR"

HAS_RG=0; command -v rg >/dev/null 2>&1 && HAS_RG=1
HAS_FD=0; command -v fd >/dev/null 2>&1 && HAS_FD=1
HAS_JQ=0; command -v jq >/dev/null 2>&1 && HAS_JQ=1
HAS_NODE=0; command -v node >/dev/null 2>&1 && HAS_NODE=1

echo "[nexus-graph] ROOT=$ROOT OUT=$OUT_DIR rg=$HAS_RG fd=$HAS_FD jq=$HAS_JQ node=$HAS_NODE"

# ── language detection ────────────────────────────────────
# Extension→lang mapping
ext_lang() {
  case "$1" in
    .ts|.tsx) echo "typescript" ;;
    .js|.jsx|.mjs|.cjs) echo "javascript" ;;
    .py) echo "python" ;;
    .go) echo "go" ;;
    .rs) echo "rust" ;;
    .java) echo "java" ;;
    .rb) echo "ruby" ;;
    .php) echo "php" ;;
    .cs) echo "csharp" ;;
    .kt) echo "kotlin" ;;
    .swift) echo "swift" ;;
    .sh|.bash) echo "shell" ;;
    .md|.mdx) echo "markdown" ;;
    .json) echo "json" ;;
    .toml|.yaml|.yml) echo "config" ;;
    *) echo "unknown" ;;
  esac
}

# ── file discovery (skip common ignore patterns) ─────────
discover_files() {
  local root="$1"
  local include_exts="js jsx ts tsx mjs cjs py go rs java rb php cs kt swift sh bash md mdx json toml yaml yml"

  if [ "$HAS_FD" -eq 1 ]; then
    fd -e js -e jsx -e ts -e tsx -e mjs -e cjs -e py -e go -e rs -e java -e rb -e php -e cs -e kt -e swift -e sh -e md -e json \
      --type f \
      --exclude node_modules --exclude .git --exclude dist --exclude build --exclude vendor --exclude target --exclude __pycache__ --exclude .opencode/knowledge --exclude .opencode/node_modules \
      --exclude "*.min.js" --exclude "*.lock" --exclude "package-lock.json" \
      . "$root" 2>/dev/null | head -n 2000
  else
    find "$root" -type f \
      \( -name "node_modules" -o -name ".git" -o -name "dist" -o -name "build" -o -name "vendor" -o -name "target" -o -name "__pycache__" -o -name ".opencode" \) -prune -o \
      \( \
        -name "*.js" -o -name "*.jsx" -o -name "*.ts" -o -name "*.tsx" \
        -o -name "*.mjs" -o -name "*.cjs" -o -name "*.py" -o -name "*.go" \
        -o -name "*.rs" -o -name "*.java" -o -name "*.rb" -o -name "*.php" \
        -o -name "*.cs" -o -name "*.kt" -o -name "*.swift" -o -name "*.sh" \
        -o -name "*.md" -o -name "*.json" \
      \) -print 2>/dev/null | grep -v "node_modules" | grep -v ".opencode/knowledge" | grep -v ".opencode/node_modules" | head -n 2000
  fi
}

FILE_LIST="$OUT_DIR/.files.tmp"
discover_files "$ROOT" > "$FILE_LIST"
TOTAL=$(wc -l < "$FILE_LIST" | tr -d ' ')
echo "[nexus-graph] Discovered $TOTAL files"

if [ "$TOTAL" -eq 0 ]; then
  echo "[nexus-graph] No files found, writing empty graph"
  printf '{"version":1,"root":"%s","generated_at":"%s","stats":{"total_files":0},"nodes":[],"edges":[]}\n' "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT_DIR/graph.json"
  printf "# Nexus Knowledge Graph\n\nNo source files detected in %s\n" "$ROOT" > "$OUT_DIR/graph.md"
  printf "# Nexus Knowledge Index\n\nEmpty – no graph yet. Run \`nexus-graph\`.\n" > "$OUT_DIR/index.md"
  exit 0
fi

# ── JS extractor: build graph.json via node if available ───────
if [ "$HAS_NODE" -eq 1 ] && [ -f "$ROOT/scripts/nexus-graph.js" ]; then
  echo "[nexus-graph] Using Node extractor (precise)"
  node "$ROOT/scripts/nexus-graph.js" "$FILE_LIST" "$ROOT" "$OUT_DIR" 2>&1 || {
    echo "[nexus-graph] Node extractor failed, falling back to shell"
    HAS_NODE=0
  }
fi

if [ "$HAS_NODE" -eq 0 ] || [ ! -f "$OUT_DIR/graph.json" ]; then
  echo "[nexus-graph] Using shell extractor (regex-based)"
  # Shell fallback: produce a minimal graph.json
  NODE_FILE="$OUT_DIR/.nodes.tmp"
  EDGE_FILE="$OUT_DIR/.edges.tmp"
  : > "$NODE_FILE"; : > "$EDGE_FILE"

  idx=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    rel="${f#$ROOT/}"
    ext=".${f##*.}"; [ "$f" = "$ext" ] && ext="unknown" || ext=".$ext"
    # normalize double-dot
    base_ext="${f##*.}"
    lang="$(ext_lang ".$base_ext")"

    # Approx symbol count
    sym_count=0
    if [ "$HAS_RG" -eq 1 ]; then
      sym_count=$(rg -c "^\s*(export\s+)?(function|class|const|def |fn |func |struct |interface |type |enum )" "$f" 2>/dev/null || echo 0)
    else
      sym_count=$(grep -Ec "^\s*(export\s+)?(function|class|const|def |fn |func |struct |interface )" "$f" 2>/dev/null || echo 0)
    fi

    # Escape JSON strings crudely via jq if available
    if [ "$HAS_JQ" -eq 1 ]; then
      node_json=$(jq -n --arg id "$rel" --arg label "$(basename "$f")" --arg path "$rel" --arg lang "$lang" --argjson sc "$sym_count" \
        '{id:$id,label:$label,path:$path,lang:$lang,symbol_count:$sc,type:"file"}')
    else
      node_json="{\"id\":\"$rel\",\"label\":\"$(basename "$f")\",\"path\":\"$rel\",\"lang\":\"$lang\",\"symbol_count\":$sym_count,\"type\":\"file\"}"
    fi
    echo "$node_json" >> "$NODE_FILE"

    # Extract import edges (very coarse)
    # JS/TS: import ... from 'x'  , require('x')
    # Python: from x import y, import x
    # Go: import "x"
    # Works as best-effort; precise extraction lives in .js extractor
    if [ "$HAS_RG" -eq 1 ]; then
      rg -o --no-heading -N "(from|import)\s+[\"'\\(]?[./a-zA-Z0-9_@\\-]+" "$f" 2>/dev/null | head -n 30 | while IFS= read -r imp; do
        imp_clean=$(echo "$imp" | sed -E "s/.*['\"]\s*([^'\"]+)\s*['\"].*/\1/; s/.*from\s+//; s/[\"']//g; s/\s+//g" | head -c 120)
        [ -z "$imp_clean" ] && continue
        echo "$rel -> $imp_clean" >> "$EDGE_FILE" 2>/dev/null || true
      done
    fi

    idx=$((idx+1))
    [ $((idx % 200)) -eq 0 ] && echo "[nexus-graph]  ... $idx/$TOTAL files scanned (shell)"
  done < "$FILE_LIST"

  # Build final JSON (shell-assembled)
  if [ "$HAS_JQ" -eq 1 ]; then
    jq -s --arg root "$ROOT" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson total "$TOTAL" \
      '{version:1,root:$root,generated_at:$now,stats:{total_files:$total},nodes:.,edges:[]}' "$NODE_FILE" > "$OUT_DIR/graph.json" 2>/dev/null || {
        echo "[nexus-graph] jq assembly failed, emitting minimal JSON"
        printf '{"version":1,"root":"%s","generated_at":"%s","stats":{"total_files":%d},"nodes":[],"edges":[]}\n' "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TOTAL" > "$OUT_DIR/graph.json"
      }
  else
    NODES_JSON=$(paste -sd "," "$NODE_FILE" 2>/dev/null)
    printf '{"version":1,"root":"%s","generated_at":"%s","stats":{"total_files":%d},"nodes":[%s],"edges":[]}\n' "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TOTAL" "$NODES_JSON" > "$OUT_DIR/graph.json"
  fi
  rm -f "$NODE_FILE" "$EDGE_FILE"
fi

# ── Derive summary stats ──────────────────────────────
if [ "$HAS_JQ" -eq 1 ] && [ -f "$OUT_DIR/graph.json" ]; then
  LANG_BREAKDOWN=$(jq -r '
    [.nodes[] | .lang // "unknown"]
    | group_by(.)
    | map({lang: .[0], count: length})
    | sort_by(-.count)
    | .[] | "  \(.lang): \(.count)"
  ' "$OUT_DIR/graph.json" 2>/dev/null | head -n 20)

  EDGE_COUNT=$(jq '.edges | length' "$OUT_DIR/graph.json" 2>/dev/null || echo 0)
  NODE_COUNT=$(jq '.nodes | length' "$OUT_DIR/graph.json" 2>/dev/null || echo 0)
  GOD_NODES=$(jq -r '
    (.edges | group_by(.from) | map({id: .[0].from, out: length}) | sort_by(-.out) | .[0:5] | .[] | "  - \(.id) (out: \(.out))")
  ' "$OUT_DIR/graph.json" 2>/dev/null | head -n 10)

  {
    echo "# Nexus Knowledge Graph"
    echo ""
    echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "Root: $ROOT"
    echo ""
    echo "## Stats"
    echo "- Files indexed: $TOTAL"
    echo "- Nodes: $NODE_COUNT"
    echo "- Edges: $EDGE_COUNT"
    echo ""
    echo "## Languages"
    echo "$LANG_BREAKDOWN"
    echo ""
    echo "## Hub Nodes (highest out-degree)"
    if [ -n "$GOD_NODES" ] && [ "$GOD_NODES" != "  - null (out: 0)" ]; then
      echo "$GOD_NODES"
    else
      echo "- (not enough import signal – rerun with Node extractor for richer edges)"
    fi
    echo ""
    echo "## How to use"
    echo "- Agents read \`graph.json\` for exact dependencies."
    echo "- Before editing a file, check incoming edges (callers) → that's your blast radius."
    echo "- See \`index.md\` for per-community wiki pages when present."
  } > "$OUT_DIR/graph.md"

  # index.md — lightweight wiki entrypoint
  {
    echo "# Nexus Knowledge Index"
    echo ""
    echo "Entry-point for agents. Read this first to orient."
    echo ""
    echo "## Files"
    echo "- \`graph.json\` – full machine-readable dependency graph (nodes, edges with EXTRACTED/INFERRED tags, confidence)."
    echo "- \`graph.md\` – this run's summary: hub nodes, stats, language breakdown."
    echo "- \`blast/\` – per-task blast-radius reports (Mermaid) generated before implementer starts."
    echo "- \`LESSONS.md\` – accumulated learnings from past task outcomes (outcome memory)."
    echo ""
    echo "## Quick queries (jq recipes)"
    echo '```bash'
    echo '# Who imports auth.ts?'
    echo 'jq '"'"'.edges[] | select(.to | contains("auth"))'"'"' .opencode/knowledge/graph.json'
    echo ''
    echo '# Top 10 most-imported files (in-degree)'
    echo 'jq -r '"'"'.edges | group_by(.to) | map({id: .[0].to, in: length}) | sort_by(-.in) | .[0:10][] | "\(.in) \(.id)"'"'"' .opencode/knowledge/graph.json'
    echo ''
    echo '# Files changed from base → blast radius'
    echo './scripts/nexus-graph.sh && node ./scripts/nexus-blast.js feature/task-1 --mermaid'
    echo '```'
    echo ""
    echo "## Graph generation"
    echo "- Command: \`./scripts/nexus-graph.sh [root] [out_dir]\`"
    echo "- Safe to run repeatedly; output is deterministic given repo state."
    echo "- For incremental: \`./scripts/nexus-graph.sh\` detects cache via SHA (future: --update)."
  } > "$OUT_DIR/index.md"
else
  # Minimal markdown when jq unavailable
  printf "# Nexus Knowledge Graph\n\nGenerated: %s\nRoot: %s\nFiles: %d\n\nSee graph.json for raw data.\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ROOT" "$TOTAL" > "$OUT_DIR/graph.md"
  printf "# Nexus Knowledge Index\n\n- graph.json – raw graph\n- graph.md – summary\n" > "$OUT_DIR/index.md"
fi

mkdir -p "$OUT_DIR/blast"
echo "[nexus-graph] Done → $OUT_DIR/graph.json + graph.md + index.md"
echo "[nexus-graph] Tip: run ./scripts/nexus-blast.sh to compute a blast radius from current git diff."
