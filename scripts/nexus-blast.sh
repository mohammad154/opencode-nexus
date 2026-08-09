#!/usr/bin/env bash
# nexus-blast.sh — thin wrapper around the Graphify-backed nexus-blast.js
# Usage: ./scripts/nexus-blast.sh [--base main] [--files a,b] [--task N] [--mermaid] [--json] [--explain file]
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "[nexus-blast] node is required for the Graphify-backed blast adapter." >&2
  exit 1
fi
node "$ROOT/scripts/nexus-blast.js" "$@"
