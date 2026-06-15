#!/usr/bin/env bash
set -euo pipefail

echo "Installing OpenCode Nexus..."

if ! command -v opencode >/dev/null 2>&1; then
  echo "Error: OpenCode is not installed."
  echo "Install OpenCode first: https://opencode.ai/docs/installation/"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required for non-destructive opencode.json merge."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
AGENTS_DIR="$CONFIG_DIR/agents"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
PLUGIN_SPEC="${NEXUS_PLUGIN_SPEC:-nexus@git+https://github.com/mohammad154/opencode-nexus.git}"

mkdir -p "$CONFIG_DIR" "$AGENTS_DIR"

if [ -f "$CONFIG_FILE" ]; then
  cp "$CONFIG_FILE" "$CONFIG_FILE.bak"
else
  printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$CONFIG_FILE"
fi

TMP_JSON="$(mktemp)"
jq --arg plugin "$PLUGIN_SPEC" '
  .plugin = (.plugin // []) |
  if (.plugin | index($plugin)) then . else .plugin += [$plugin] end
' "$CONFIG_FILE" > "$TMP_JSON"
mv "$TMP_JSON" "$CONFIG_FILE"

for agent in orchestrator implementer spec-reviewer code-reviewer; do
  target="$AGENTS_DIR/$agent.md"
  source="$SCRIPT_DIR/agents/$agent.md"
  if [ -f "$target" ]; then
    cp "$target" "$target.bak"
  fi
  cp "$source" "$target"
done

echo "Installation complete."
echo "Restart OpenCode, then try:"
echo "\"Use the orchestrating skill to implement a small feature with tests.\""
