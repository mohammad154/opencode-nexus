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
MODELS_FILE="$CONFIG_DIR/nexus.models.json"
DEFAULT_MODELS="$SCRIPT_DIR/config/default-models.json"
MODELS_EXAMPLE="$SCRIPT_DIR/config/models.example.json"
PLUGIN_SPEC="${NEXUS_PLUGIN_SPEC:-nexus@git+https://github.com/mohammad154/opencode-nexus.git}"

mkdir -p "$CONFIG_DIR" "$AGENTS_DIR"

if [ -f "$CONFIG_FILE" ]; then
  cp "$CONFIG_FILE" "$CONFIG_FILE.bak"
else
  printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$CONFIG_FILE"
fi

# Build effective model config: defaults -> user file -> environment variables
MODELS_JSON="$(cat "$DEFAULT_MODELS")"
if [ -f "$MODELS_FILE" ]; then
  MODELS_JSON="$(jq -s 'def strip_meta: with_entries(select(.key | startswith("_") | not)); .[0] * (.[1] | strip_meta)' "$DEFAULT_MODELS" "$MODELS_FILE")"
else
  cp "$MODELS_EXAMPLE" "$CONFIG_DIR/nexus.models.example.json"
  echo "Created $CONFIG_DIR/nexus.models.example.json"
  echo "Copy it to $MODELS_FILE to customize agent models, then re-run install.sh"
fi

apply_env_model() {
  local agent="$1"
  local env_var="$2"
  local value="${!env_var:-}"
  if [ -n "$value" ]; then
    MODELS_JSON="$(jq --arg agent "$agent" --arg model "$value" '.[$agent].model = $model' <<<"$MODELS_JSON")"
  fi
}

apply_env_reasoning() {
  local agent="$1"
  local env_var="$2"
  local value="${!env_var:-}"
  if [ -n "$value" ]; then
    MODELS_JSON="$(jq --arg agent "$agent" --arg effort "$value" '.[$agent].reasoningEffort = $effort' <<<"$MODELS_JSON")"
  fi
}

apply_env_model orchestrator NEXUS_ORCHESTRATOR_MODEL
apply_env_model implementer NEXUS_IMPLEMENTER_MODEL
apply_env_model spec-reviewer NEXUS_SPEC_REVIEWER_MODEL
apply_env_model code-reviewer NEXUS_CODE_REVIEWER_MODEL

apply_env_reasoning implementer NEXUS_IMPLEMENTER_REASONING_EFFORT
apply_env_reasoning spec-reviewer NEXUS_SPEC_REVIEWER_REASONING_EFFORT
apply_env_reasoning code-reviewer NEXUS_CODE_REVIEWER_REASONING_EFFORT

TMP_JSON="$(mktemp)"
jq --arg plugin "$PLUGIN_SPEC" --argjson models "$MODELS_JSON" '
  .plugin = (.plugin // []) |
  if (.plugin | index($plugin)) then . else .plugin += [$plugin] end |
  .agent = (.agent // {}) |
  reduce ($models | keys[]) as $name (.;
    .agent[$name] = ((.agent[$name] // {}) + $models[$name])
  )
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
echo "Agent models configured in $CONFIG_FILE under .agent"
echo "To customize models, edit $MODELS_FILE (see nexus.models.example.json) and re-run install.sh"
echo "Restart OpenCode, then try:"
echo "\"Use the orchestrating skill to implement a small feature with tests.\""
