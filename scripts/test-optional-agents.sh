#!/usr/bin/env bash
# Ensure default install demotes optional agents; --with-optional-agents restores them.
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
export PATH="$HOME/bin:$SANITIZED_PATH"
printf '{}\n' >"$HOME/.config/opencode/opencode.json"

echo "== default install: no optional agents =="
"$ROOT/install.sh" --only opencode >/tmp/nexus-install-default.log 2>&1 || {
  cat /tmp/nexus-install-default.log
  exit 1
}
test -f "$HOME/.config/opencode/agents/orchestrator.md"
test -f "$HOME/.config/opencode/agents/implementer.md"
test ! -f "$HOME/.config/opencode/agents/blast-analyzer.md"
test ! -f "$HOME/.config/opencode/agents/knowledge-graph.md"
grep -q 'Optional agents skipped' /tmp/nexus-install-default.log
echo "PASS: default install omits graph/blast agents"

echo "== --with-optional-agents =="
"$ROOT/install.sh" --only opencode --with-optional-agents >/tmp/nexus-install-opt.log 2>&1 || {
  cat /tmp/nexus-install-opt.log
  exit 1
}
test -f "$HOME/.config/opencode/agents/blast-analyzer.md"
test -f "$HOME/.config/opencode/agents/knowledge-graph.md"
echo "PASS: --with-optional-agents installs optional agents"

echo "== --prune-optional-agents =="
"$ROOT/install.sh" --only opencode --prune-optional-agents >/tmp/nexus-install-prune.log 2>&1 || {
  cat /tmp/nexus-install-prune.log
  exit 1
}
test ! -f "$HOME/.config/opencode/agents/blast-analyzer.md"
test ! -f "$HOME/.config/opencode/agents/knowledge-graph.md"
test -f "$HOME/.config/opencode/agents/orchestrator.md"
echo "PASS: prune removes optional agents, keeps defaults"

# Agent source files still in repo
test -f "$ROOT/agents/blast-analyzer.md"
test -f "$ROOT/agents/knowledge-graph.md"
echo "PASS: optional agent markdown retained in repo"
