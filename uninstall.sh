#!/usr/bin/env bash
set -euo pipefail

echo "Uninstalling OpenCode Nexus..."

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required to safely remove plugin entry."
  exit 1
fi

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
AGENTS_DIR="$CONFIG_DIR/agents"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
PLUGIN_SPEC="${NEXUS_PLUGIN_SPEC:-nexus@git+https://github.com/mohammad154/opencode-nexus.git}"

if [ -f "$CONFIG_FILE" ]; then
  TMP_JSON="$(mktemp)"
  jq --arg plugin "$PLUGIN_SPEC" '
    .plugin = ((.plugin // []) | map(select(. != $plugin)))
  ' "$CONFIG_FILE" > "$TMP_JSON"
  mv "$TMP_JSON" "$CONFIG_FILE"
fi

for agent in orchestrator implementer spec-reviewer code-reviewer; do
  target="$AGENTS_DIR/$agent.md"
  backup="$target.bak"
  if [ -f "$backup" ]; then
    mv "$backup" "$target"
  else
    rm -f "$target"
  fi
done

echo "Uninstall complete."
echo "Note: project-local workflow files under .opencode/ were not modified."
