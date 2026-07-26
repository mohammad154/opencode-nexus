#!/usr/bin/env bash
# Regression: --only must never touch other platforms; auto-detect must not write AG.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPHOME="$(mktemp -d)"
cleanup() { rm -rf "$TMPHOME"; }
trap cleanup EXIT

export HOME="$TMPHOME"
mkdir -p "$HOME/.config/opencode" "$HOME/.gemini/skills" "$HOME/.gemini/config/skills" \
  "$HOME/.gemini/antigravity/skills" "$HOME/.antigravity" "$HOME/bin"
printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/ag"; chmod +x "$HOME/bin/ag"
printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/gemini"; chmod +x "$HOME/bin/gemini"
printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/opencode"; chmod +x "$HOME/bin/opencode"
export PATH="$HOME/bin:/usr/bin:/bin:${PATH:-}"
printf '{}\n' >"$HOME/.config/opencode/opencode.json"

echo "== test --only opencode =="
out="$("$ROOT/install.sh" --only opencode 2>&1)" || { echo "$out"; exit 1; }
echo "$out" | grep -q 'Strict --only allowlist: opencode'
echo "$out" | grep -q 'opencode:.*will install'
echo "$out" | grep -q 'antigravity:.*skipped (--only)'
echo "$out" | grep -q 'gemini:.*skipped (--only)'
echo "$out" | grep -qv '\[antigravity\]'
echo "$out" | grep -qv '\[gemini\]'
echo "$out" | grep -qv '\[claude\]'
echo "$out" | grep -qv '\[cursor\]'

if find "$HOME/.gemini" "$HOME/.antigravity" "$HOME/.claude" "$HOME/.cursor" \
    "$HOME/.codex" "$HOME/.agents" -iname '*nexus*' 2>/dev/null | grep -q .; then
  echo "FAIL: --only opencode wrote non-OpenCode nexus files:" >&2
  find "$HOME" -iname '*nexus*' 2>/dev/null >&2 || true
  exit 1
fi
test "$(ls "$HOME/.config/opencode/agents" 2>/dev/null | wc -l)" -gt 0
echo "PASS: --only opencode isolates OpenCode"

# Fresh home for auto-detect
rm -rf "$TMPHOME"
TMPHOME="$(mktemp -d)"
export HOME="$TMPHOME"
mkdir -p "$HOME/.config/opencode" "$HOME/.gemini/skills" "$HOME/bin"
printf '{}\n' >"$HOME/.config/opencode/opencode.json"
for b in ag gemini opencode; do printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/$b"; chmod +x "$HOME/bin/$b"; done
export PATH="$HOME/bin:/usr/bin:/bin:${PATH:-}"

echo "== test default auto-detect (ag + gemini present, no AG) =="
out="$("$ROOT/install.sh" 2>&1)" || { echo "$out"; exit 1; }
echo "$out" | grep -q 'opencode: detected → will install'
echo "$out" | grep -q 'gemini: detected → will install'
echo "$out" | grep -q 'antigravity: not detected → skipped'
echo "$out" | grep -qv '\[antigravity\]'
echo "$out" | grep -q 'claude: not detected → skipped'
echo "$out" | grep -q 'cursor: not detected → skipped'

if find "$HOME" \( -path '*/config/skills/*' -o -path '*/antigravity/*' -o -path '*/.antigravity/*' \) \
    -iname '*nexus*' 2>/dev/null | grep -q .; then
  echo "FAIL: auto-detect wrote Antigravity paths:" >&2
  find "$HOME" -iname '*nexus*' 2>/dev/null >&2 || true
  exit 1
fi
test "$(find "$HOME/.gemini/skills" -iname '*nexus*' 2>/dev/null | wc -l)" -gt 0
echo "PASS: default install detects gemini, skips Antigravity (ignores ag binary)"
