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
jq -e '(.agent | has("blast-analyzer")) | not' "$HOME/.config/opencode/opencode.json" >/dev/null
grep -q '^install --platform opencode$' "$GRAPHIFY_LOG"
# Graphify is optional for V4, but when present on PATH the installer may wire the skill.
# `graphify opencode install` is a PROJECT-level mutation and must NOT run from a
# global `nexus install`; it belongs to `nexus project-init`.
if grep -q '^opencode install$' "$GRAPHIFY_LOG"; then
  echo "FAIL: global install performed project-level 'graphify opencode install'" >&2
  exit 1
fi
echo "PASS: installer writes only OpenCode artifacts"

echo "== rejected unknown flags =="
if run_install --only cursor >/tmp/nexus-unknown-flag.log 2>&1; then
  cat /tmp/nexus-unknown-flag.log
  echo "FAIL: leftover platform flags should be rejected" >&2
  exit 1
fi
grep -qi 'unknown argument' /tmp/nexus-unknown-flag.log
echo "PASS: leftover platform flags are rejected"

echo "== Graphify optional (install succeeds without Graphify) =="
MISSING_HOME="$(mktemp -d)"
mkdir -p "$MISSING_HOME/.config/opencode" "$MISSING_HOME/project"
git init -q "$MISSING_HOME/project"
printf '{}\n' >"$MISSING_HOME/.config/opencode/opencode.json"
if ! (
  export HOME="$MISSING_HOME" PATH="$SANITIZED_PATH"
  cd "$MISSING_HOME/project"
  "$ROOT/install.sh"
) >"$MISSING_HOME/missing-graphify.log" 2>&1; then
  cat "$MISSING_HOME/missing-graphify.log"
  echo "FAIL: OpenCode install should succeed without Graphify in V4" >&2
  exit 1
fi
grep -qi 'Graphify not on PATH\|Graphify is optional\|V5' "$MISSING_HOME/missing-graphify.log"
test -f "$MISSING_HOME/.config/opencode/agents/orchestrator.md"
test -f "$MISSING_HOME/.config/opencode/agents/implementer.md"
test -f "$MISSING_HOME/.config/opencode/agents/reviewer.md"
test ! -f "$MISSING_HOME/.config/opencode/agents/diagnostician.md"
test ! -f "$MISSING_HOME/.config/opencode/agents/integration-reviewer.md"
test ! -f "$MISSING_HOME/.config/opencode/agents/unified-reviewer.md"
echo "PASS: install without Graphify succeeds and installs V5 agents only"

bash "$ROOT/scripts/test-adapter-contract.sh"

echo "== upgrade-from-V4 prunes retired agent config =="
UPG_HOME="$(mktemp -d)"
mkdir -p "$UPG_HOME/.config/opencode/agents" "$UPG_HOME/project" "$UPG_HOME/bin"
git init -q "$UPG_HOME/project"
printf '#!/bin/sh\nexit 0\n' >"$UPG_HOME/bin/opencode"; chmod +x "$UPG_HOME/bin/opencode"
cat >"$UPG_HOME/.config/opencode/opencode.json" <<'JSON'
{
  "plugin": [],
  "agent": {
    "orchestrator": { "model": "x" },
    "implementer": { "model": "x" },
    "unified-reviewer": { "model": "old" },
    "spec-reviewer": { "model": "old" },
    "diagnostician": { "model": "old" }
  }
}
JSON
printf '# leftover\n' >"$UPG_HOME/.config/opencode/agents/unified-reviewer.md"
(
  export HOME="$UPG_HOME" PATH="$UPG_HOME/bin:/usr/bin:/bin"
  cd "$UPG_HOME/project"
  "$ROOT/install.sh"
) >/tmp/nexus-upgrade-v4.log 2>&1 || { cat /tmp/nexus-upgrade-v4.log; rm -rf "$UPG_HOME"; exit 1; }
jq -e '(.agent | has("unified-reviewer")) | not' "$UPG_HOME/.config/opencode/opencode.json" >/dev/null
jq -e '(.agent | has("spec-reviewer")) | not' "$UPG_HOME/.config/opencode/opencode.json" >/dev/null
jq -e '(.agent | has("diagnostician")) | not' "$UPG_HOME/.config/opencode/opencode.json" >/dev/null
jq -e '.agent | has("reviewer")' "$UPG_HOME/.config/opencode/opencode.json" >/dev/null
test ! -f "$UPG_HOME/.config/opencode/agents/unified-reviewer.md"
test -f "$UPG_HOME/.config/opencode/agents/reviewer.md"
rm -rf "$UPG_HOME"
echo "PASS: V4→V5 upgrade prunes retired agent config and files"
