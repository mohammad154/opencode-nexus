#!/usr/bin/env bash
# Thin wrapper around nexus-estimate-cost.js (falls back to inline echo if no node).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if command -v node >/dev/null 2>&1; then
  exec node "$ROOT/scripts/nexus-estimate-cost.js" "$@"
fi
TASKS=3
PROFILE=balanced
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tasks) TASKS="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    *) shift ;;
  esac
done
STRICT=$((TASKS * 3))
case "$PROFILE" in
  strict) EST=$STRICT ;;
  fast) EST=$(( (TASKS + 2) / 3 * 2 )) ;;
  *) EST=$(( (TASKS + 2) / 3 * 2 )) ;;
esac
echo "Recommended profile: $PROFILE"
echo "Estimated calls: $EST instead of $STRICT (strict)"
echo "Reason: shell fallback estimate (install node for precise JSON)."
