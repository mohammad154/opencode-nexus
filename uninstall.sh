#!/usr/bin/env bash
set -euo pipefail

echo "Uninstalling OpenCode Nexus..."

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required to safely remove plugin entry."
  exit 1
fi

restore_from_backup() {
  local target="$1"
  local latest
  latest="$(ls -t "$target".bak.* 2>/dev/null | head -1 || true)"
  if [ -n "$latest" ]; then
    mv "$latest" "$target"
  elif [ -f "$target.bak" ]; then
    mv "$target.bak" "$target"
  else
    rm -f "$target"
  fi
}

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
AGENTS_DIR="$CONFIG_DIR/agents"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
PLUGIN_SPEC="${NEXUS_PLUGIN_SPEC:-nexus@git+https://github.com/mohammad154/opencode-nexus.git}"
NEXUS_AGENTS='["orchestrator","implementer","spec-reviewer","code-reviewer"]'

if [ -f "$CONFIG_FILE" ]; then
  TMP_JSON="$(mktemp)"
  trap 'rm -f "$TMP_JSON"' EXIT
  jq --arg plugin "$PLUGIN_SPEC" --argjson names "$NEXUS_AGENTS" '
    .plugin = ((.plugin // []) | map(select(. != $plugin))) |
    reduce $names[] as $name (.;
      if .agent[$name] then
        .agent[$name] |= del(.model, .reasoningEffort) |
        if .agent[$name] == {} then .agent |= del(.[$name]) else . end
      else .
      end
    )
  ' "$CONFIG_FILE" > "$TMP_JSON"
  mv "$TMP_JSON" "$CONFIG_FILE"
fi

for agent in orchestrator implementer spec-reviewer code-reviewer; do
  target="$AGENTS_DIR/$agent.md"
  restore_from_backup "$target"
done

rm -f "$CONFIG_DIR/nexus.models.example.json"

echo "Uninstall complete."
echo "Note: project-local workflow files under .opencode/ were not modified."
echo "Note: $CONFIG_DIR/nexus.models.json was kept so you can reinstall with the same model choices."
