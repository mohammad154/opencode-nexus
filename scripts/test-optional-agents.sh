#!/usr/bin/env bash
# V5: default install has only three agents; retired V4 agents are pruned.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPHOME="$(mktemp -d)"
cleanup() { rm -rf "$TMPHOME"; }
trap cleanup EXIT

SANITIZED_PATH="/usr/bin:/bin"
export HOME="$TMPHOME"
mkdir -p "$HOME/.config/opencode" "$HOME/bin"
printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/opencode"; chmod +x "$HOME/bin/opencode"
export PATH="$HOME/bin:$SANITIZED_PATH"
printf '{}\n' >"$HOME/.config/opencode/opencode.json"
CONFIG="$HOME/.config/opencode/opencode.json"
AGENTS="$HOME/.config/opencode/agents"

echo "== V5 default install: three canonical agents =="
"$ROOT/install.sh" >/tmp/nexus-install-default.log 2>&1 || {
  cat /tmp/nexus-install-default.log
  exit 1
}
test -f "$AGENTS/orchestrator.md"
test -f "$AGENTS/implementer.md"
test -f "$AGENTS/reviewer.md"
test ! -f "$AGENTS/blast-analyzer.md"
test ! -f "$AGENTS/unified-reviewer.md"
test ! -f "$AGENTS/diagnostician.md"
jq -e '(.agent | has("reviewer"))' "$CONFIG" >/dev/null
jq -e '(.agent | has("blast-analyzer")) | not' "$CONFIG" >/dev/null
echo "PASS: V5 install has orchestrator, implementer, reviewer only"

echo "== prune retires leftover V4 agent files =="
mkdir -p "$AGENTS"
printf '# leftover\n' >"$AGENTS/unified-reviewer.md"
"$ROOT/install.sh" --prune-optional-agents >/tmp/nexus-install-prune.log 2>&1 || {
  cat /tmp/nexus-install-prune.log
  exit 1
}
test ! -f "$AGENTS/unified-reviewer.md"
test -f "$AGENTS/reviewer.md"
echo "PASS: retired agents pruned"

echo "All optional-agent V5 checks passed."
