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
mkdir -p "$HOME/.config/opencode" "$HOME/.gemini/skills" "$HOME/.gemini/config/skills" \
  "$HOME/.gemini/antigravity/skills" "$HOME/.antigravity" "$HOME/bin" "$HOME/project"
git init -q "$HOME/project"
printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/ag"; chmod +x "$HOME/bin/ag"
printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/gemini"; chmod +x "$HOME/bin/gemini"
printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/opencode"; chmod +x "$HOME/bin/opencode"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"$GRAPHIFY_LOG"\n' >"$HOME/bin/graphify"; chmod +x "$HOME/bin/graphify"
export PATH="$HOME/bin:$SANITIZED_PATH"
export GRAPHIFY_LOG="$HOME/graphify.log"
printf '{}\n' >"$HOME/.config/opencode/opencode.json"

echo "== test OpenCode-only install =="
out="$(run_install 2>&1)" || { echo "$out"; exit 1; }
echo "$out" | grep -q 'OpenCode: detected'
echo "$out" | grep -q '\[opencode\] Done'
echo "$out" | grep -qv '\[antigravity\]'
echo "$out" | grep -qv '\[gemini\]'
echo "$out" | grep -qv '\[claude\]'
echo "$out" | grep -qv '\[cursor\]'
echo "$out" | grep -qv '\[codex\]'

if find "$HOME/.gemini" "$HOME/.antigravity" "$HOME/.claude" "$HOME/.cursor" \
    "$HOME/.codex" "$HOME/.agents" -iname '*nexus*' 2>/dev/null | grep -q .; then
  echo "FAIL: installer wrote non-OpenCode nexus files:" >&2
  find "$HOME" -iname '*nexus*' 2>/dev/null >&2 || true
  exit 1
fi
test "$(ls "$HOME/.config/opencode/agents" 2>/dev/null | wc -l)" -gt 0
test ! -f "$HOME/.config/opencode/agents/blast-analyzer.md"
grep -q '^install --platform opencode$' "$GRAPHIFY_LOG"
grep -q '^opencode install$' "$GRAPHIFY_LOG"
echo "PASS: installer writes only OpenCode artifacts"

echo "== rejected non-OpenCode --only =="
if run_install --only cursor >/tmp/nexus-only-cursor.log 2>&1; then
  cat /tmp/nexus-only-cursor.log
  echo "FAIL: --only cursor should be rejected" >&2
  exit 1
fi
grep -qi 'only OpenCode' /tmp/nexus-only-cursor.log
echo "PASS: non-OpenCode --only is rejected"

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
