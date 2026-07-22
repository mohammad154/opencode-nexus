#!/usr/bin/env bash
# nexus-blast.sh — thin wrapper around nexus-blast.js with shell-only fallback
# Usage: ./scripts/nexus-blast.sh [--base main] [--files a,b] [--task N] [--mermaid] [--json] [--explain file]
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if command -v node >/dev/null 2>&1; then
  node "$ROOT/scripts/nexus-blast.js" "$@"
else
  echo "[nexus-blast] node not found – shell fallback (limited accuracy)"
  BASE="main"
  # Try detect base
  for b in main master develop; do git show-ref --verify --quiet "refs/heads/$b" 2>/dev/null && { BASE="$b"; break; }; done
  FILES="$(git diff --name-only "$BASE"...HEAD 2>/dev/null | tr '\n' ',' | sed 's/,$//')"
  if [ -z "$FILES" ]; then
    FILES="$( { git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; } | tr '\n' ',' | sed 's/,$//' )"
  fi
  echo "# Blast Radius (shell fallback – low fidelity)"
  echo ""
  echo "Base: $BASE"
  echo "Files: $FILES"
  echo ""
  echo "## Heuristic downstream (rg callers)"
  if command -v rg >/dev/null 2>&1; then
    for f in $(echo "$FILES" | tr ',' '\n'); do
      [ -z "$f" ] && continue
      base="$(basename "$f")"; base_no_ext="${base%.*}"
      echo "- $f → possible callers:"
      rg -l --hidden --glob '!node_modules' --glob '!.git' "$base_no_ext" "$ROOT" 2>/dev/null | head -n 20 | sed 's/^/  - /' || echo "  - (none via rg)"
    done
  else
    echo "(install rg or node for richer analysis)"
  fi
  echo ""
  echo "Run with node for Mermaid + JSON: node scripts/nexus-blast.js --mermaid"
fi
