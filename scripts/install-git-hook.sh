#!/usr/bin/env bash
# Install a post-commit hook in the current repo that refreshes .opencode/knowledge/
# Usage: ./scripts/install-git-hook.sh
#        (run from a consumer project that has scripts/nexus-graph.sh, or set NEXUS_GRAPH_SCRIPT)
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "Not a git repository" >&2
  exit 1
fi

HOOK="$ROOT/.git/hooks/post-commit"
MARK="# nexus-graph-hook"
GRAPH="${NEXUS_GRAPH_SCRIPT:-}"
if [[ -z "$GRAPH" ]]; then
  if [[ -x "$ROOT/scripts/nexus-graph.sh" ]]; then
    GRAPH="$ROOT/scripts/nexus-graph.sh"
  elif [[ -x "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nexus-graph.sh" ]]; then
    GRAPH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nexus-graph.sh"
  fi
fi

if [[ -z "$GRAPH" ]]; then
  echo "Could not find nexus-graph.sh. Copy scripts/ into this repo or set NEXUS_GRAPH_SCRIPT." >&2
  exit 1
fi

mkdir -p "$(dirname "$HOOK")"
if [[ ! -f "$HOOK" ]]; then
  printf '%s\n' '#!/usr/bin/env bash' >"$HOOK"
fi

if grep -q "$MARK" "$HOOK" 2>/dev/null; then
  echo "Already installed: $HOOK"
  exit 0
fi

{
  echo ""
  echo "$MARK"
  echo "if [[ -x \"$GRAPH\" ]]; then"
  echo "  \"$GRAPH\" \"$ROOT\" >/dev/null 2>&1 || true"
  echo "fi"
} >>"$HOOK"
chmod +x "$HOOK"
echo "Installed post-commit graph refresh → $HOOK"
echo "Uses: $GRAPH"
