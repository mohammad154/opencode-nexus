#!/usr/bin/env bash
# Regression: installer writes only OpenCode paths; Graphify remains required.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPHOME="$(mktemp -d)"
MISSING_HOME=""
cleanup() { rm -rf "$TMPHOME" "${MISSING_HOME:-}"; }
trap cleanup EXIT

SANITIZED_PATH="/usr/bin:/bin"

run_install() {
  (cd "$HOME/project" && "$ROOT/install.sh" "$@")
}

export HOME="$TMPHOME"
mkdir -p "$HOME/.config/opencode" "$HOME/bin" "$HOME/project"
git init -q "$HOME/project"
printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/opencode"; chmod +x "$HOME/bin/opencode"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"$GRAPHIFY_LOG"\n' >"$HOME/bin/graphify"; chmod +x "$HOME/bin/graphify"
export PATH="$HOME/bin:$SANITIZED_PATH"
export GRAPHIFY_LOG="$HOME/graphify.log"
printf '{}\n' >"$HOME/.config/opencode/opencode.json"

echo "== test OpenCode-only install =="
out="$(run_install 2>&1)" || { echo "$out"; exit 1; }
echo "$out" | grep -q 'OpenCode: detected'
echo "$out" | grep -q '\[opencode\] Done'

if find "$HOME" -iname '*nexus*' ! -path "$HOME/.config/opencode/*" -print -quit 2>/dev/null | grep -q .; then
  echo "FAIL: installer wrote Nexus files outside ~/.config/opencode:" >&2
  find "$HOME" -iname '*nexus*' ! -path "$HOME/.config/opencode/*" >&2 || true
  exit 1
fi
test "$(ls "$HOME/.config/opencode/agents" 2>/dev/null | wc -l)" -gt 0
test ! -f "$HOME/.config/opencode/agents/blast-analyzer.md"
grep -q '^install --platform opencode$' "$GRAPHIFY_LOG"
grep -q '^opencode install$' "$GRAPHIFY_LOG"
echo "PASS: installer writes only OpenCode artifacts"

echo "== rejected unknown flags =="
if run_install --only cursor >/tmp/nexus-unknown-flag.log 2>&1; then
  cat /tmp/nexus-unknown-flag.log
  echo "FAIL: leftover platform flags should be rejected" >&2
  exit 1
fi
grep -qi 'unknown argument' /tmp/nexus-unknown-flag.log
echo "PASS: leftover platform flags are rejected"

echo "== missing Graphify prerequisite =="
MISSING_HOME="$(mktemp -d)"
mkdir -p "$MISSING_HOME/.config/opencode" "$MISSING_HOME/project"
git init -q "$MISSING_HOME/project"
printf '{}\n' >"$MISSING_HOME/.config/opencode/opencode.json"
if (
  export HOME="$MISSING_HOME" PATH="$SANITIZED_PATH"
  cd "$MISSING_HOME/project"
  "$ROOT/install.sh"
) >"$MISSING_HOME/missing-graphify.log" 2>&1; then
  cat "$MISSING_HOME/missing-graphify.log"
  echo "FAIL: OpenCode install succeeded without Graphify" >&2
  exit 1
fi
grep -qi 'Graphify.*required' "$MISSING_HOME/missing-graphify.log"
echo "PASS: missing Graphify prerequisite is actionable"

bash "$ROOT/scripts/test-adapter-contract.sh"
