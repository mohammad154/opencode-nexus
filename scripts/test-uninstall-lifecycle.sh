#!/usr/bin/env bash
# Regression tests for uninstall lifecycle (fixes #4 and #5):
#   - upgrade → upgrade → upgrade → uninstall restores the USER'S ORIGINAL file
#     (not an intermediate Nexus-authored file), via the install manifest.
#   - uninstall WITHOUT jq still removes/restores agent files (not just JSON).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# --- Test 1: install → upgrade → upgrade → uninstall restores original -------
T1="$(mktemp -d)"
trap 'rm -rf "$T1" "${T2:-}"' EXIT
(
  export HOME="$T1"
  CD="$HOME/.config/opencode"; AD="$CD/agents"
  mkdir -p "$AD" "$HOME/bin" "$HOME/project"
  printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/graphify"; chmod +x "$HOME/bin/graphify"
  export PATH="$HOME/bin:/usr/bin:/bin"
  printf '{}\n' >"$CD/opencode.json"
  git init -q "$HOME/project"
  printf 'ORIGINAL USER ORCHESTRATOR\n' >"$AD/orchestrator.md"
  for _ in 1 2 3; do
    ( cd "$HOME/project" && "$ROOT/install.sh" ) >/dev/null 2>&1
    sleep 1
  done
  ( cd "$HOME/project" && "$ROOT/uninstall.sh" ) >/dev/null 2>&1
  grep -q '^ORIGINAL USER ORCHESTRATOR$' "$AD/orchestrator.md" \
    || { echo "restored file was: $(cat "$AD/orchestrator.md")"; exit 1; }
) || fail "upgrade→uninstall did not restore the user's original agent file"
pass "upgrade→upgrade→upgrade→uninstall restores the user's original agent file"

# --- Test 2: uninstall without jq still removes agent files ------------------
T2="$(mktemp -d)"
(
  export HOME="$T2"
  CD="$HOME/.config/opencode"; AD="$CD/agents"
  mkdir -p "$AD" "$HOME/bin" "$HOME/project"
  printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/graphify"; chmod +x "$HOME/bin/graphify"
  export PATH="$HOME/bin:/usr/bin:/bin"
  printf '{}\n' >"$CD/opencode.json"
  git init -q "$HOME/project"
  ( cd "$HOME/project" && "$ROOT/install.sh" ) >/dev/null 2>&1
  test -f "$AD/orchestrator.md" || { echo "install did not create agent"; exit 1; }

  # Build a jq-less PATH.
  NOJQ="$T2/nojqbin"; mkdir -p "$NOJQ"
  for c in bash cp mv rm ls mktemp dirname cat date find sed grep chmod head printf; do
    src="$(command -v "$c" || true)"; [[ -n "$src" ]] && ln -sf "$src" "$NOJQ/$c"
  done
  export PATH="$NOJQ"
  command -v jq >/dev/null 2>&1 && { echo "jq unexpectedly still on PATH"; exit 1; }
  ( cd "$HOME/project" && "$ROOT/uninstall.sh" ) >"$T2/uninstall.log" 2>&1
  grep -q "Uninstall complete" "$T2/uninstall.log" || { echo "no complete message"; exit 1; }
  [[ ! -f "$AD/orchestrator.md" ]] || { echo "agent file left behind"; exit 1; }
) || fail "jq-less uninstall did not remove agent files"
pass "jq-less uninstall still removes agent files"

echo "PASS: uninstall lifecycle regressions"
