#!/usr/bin/env bash
# Ensure default install omits the optional blast agent; --with-optional-agents restores it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPHOME="$(mktemp -d)"
cleanup() { rm -rf "$TMPHOME"; }
trap cleanup EXIT

# Isolate from host tooling so detection is deterministic.
SANITIZED_PATH="/usr/bin:/bin"

export HOME="$TMPHOME"
mkdir -p "$HOME/.config/opencode" "$HOME/bin"
printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/opencode"; chmod +x "$HOME/bin/opencode"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"$GRAPHIFY_LOG"\n' >"$HOME/bin/graphify"; chmod +x "$HOME/bin/graphify"
export PATH="$HOME/bin:$SANITIZED_PATH"
export GRAPHIFY_LOG="$HOME/graphify.log"
printf '{}\n' >"$HOME/.config/opencode/opencode.json"

CONFIG="$HOME/.config/opencode/opencode.json"

echo "== default install: no optional agents =="
"$ROOT/install.sh" >/tmp/nexus-install-default.log 2>&1 || {
  cat /tmp/nexus-install-default.log
  exit 1
}
test -f "$HOME/.config/opencode/agents/orchestrator.md"
test -f "$HOME/.config/opencode/agents/implementer.md"
test ! -f "$HOME/.config/opencode/agents/blast-analyzer.md"
jq -e '(.agent | has("blast-analyzer")) | not' "$CONFIG" >/dev/null
grep -q 'Optional agent skipped' /tmp/nexus-install-default.log
echo "PASS: default install omits the optional blast agent"

echo "== --with-optional-agents =="
"$ROOT/install.sh" --with-optional-agents >/tmp/nexus-install-opt.log 2>&1 || {
  cat /tmp/nexus-install-opt.log
  exit 1
}
test -f "$HOME/.config/opencode/agents/blast-analyzer.md"
jq -e '.agent["blast-analyzer"] | type == "object"' "$CONFIG" >/dev/null
echo "PASS: --with-optional-agents installs the optional blast agent"

echo "== --prune-optional-agents =="
"$ROOT/install.sh" --prune-optional-agents >/tmp/nexus-install-prune.log 2>&1 || {
  cat /tmp/nexus-install-prune.log
  exit 1
}
test ! -f "$HOME/.config/opencode/agents/blast-analyzer.md"
test -f "$HOME/.config/opencode/agents/orchestrator.md"
jq -e '(.agent | has("blast-analyzer")) | not' "$CONFIG" >/dev/null
jq -e '.agent | has("orchestrator")' "$CONFIG" >/dev/null
echo "PASS: prune removes optional agents, keeps defaults"

echo "== default install strips leaked optional agent config =="
jq -n --argjson existing "$(cat "$CONFIG")" '
  $existing * {agent: (($existing.agent // {}) + {"blast-analyzer": {"model": "leaked/model"}})}
' >"$CONFIG"
test ! -f "$HOME/.config/opencode/agents/blast-analyzer.md"
"$ROOT/install.sh" >/tmp/nexus-install-leaked.log 2>&1 || {
  cat /tmp/nexus-install-leaked.log
  exit 1
}
test ! -f "$HOME/.config/opencode/agents/blast-analyzer.md"
jq -e '(.agent | has("blast-analyzer")) | not' "$CONFIG" >/dev/null
jq -e '.agent | has("orchestrator")' "$CONFIG" >/dev/null
echo "PASS: default install removes leaked blast-analyzer config"

# Agent source files still in repo
test -f "$ROOT/agents/blast-analyzer.md"
echo "PASS: optional agent markdown retained in repo"
