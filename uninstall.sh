#!/usr/bin/env bash
# OpenCode Nexus uninstaller — mirrors install.sh
# Usage: ./uninstall.sh [-h]
set -euo pipefail

echo "Uninstalling OpenCode Nexus..."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only=*)
      only="${1#--only=}"
      shift
      if [[ "$(echo "$only" | tr 'A-Z' 'a-z')" != "opencode" ]]; then
        echo "Error: OpenCode Nexus uninstalls only OpenCode (got --only $only)" >&2
        exit 1
      fi
      ;;
    --only)
      shift
      if [[ $# -eq 0 || "$1" == -* ]]; then
        echo "Error: --only requires a platform name (only 'opencode' is supported)" >&2
        exit 1
      fi
      only="$(echo "$1" | tr 'A-Z' 'a-z')"
      shift
      if [[ "$only" != "opencode" ]]; then
        echo "Error: OpenCode Nexus uninstalls only OpenCode (got --only $only)" >&2
        exit 1
      fi
      ;;
    --all) shift ;;  # compat: only OpenCode remains
    -h|--help)
      cat <<'USAGE'
Usage: ./uninstall.sh
Removes the OpenCode Nexus plugin, agent files, and model example from ~/.config/opencode/.
USAGE
      exit 0 ;;
    opencode) shift ;;  # compat: ./uninstall.sh opencode
    *)
      echo "Error: unknown argument: $1 (OpenCode is the only supported platform; use --help)" >&2
      exit 1
      ;;
  esac
done

bak_restore() {
  local t=$1; local latest; latest="$(ls -t "$t".bak.* 2>/dev/null | head -1 || true)"
  if [[ -n "$latest" ]]; then mv "$latest" "$t"; elif [[ -f "$t.bak" ]]; then mv "$t.bak" "$t"; else rm -f "$t"; fi
}

echo ""; echo "[opencode] Removing..."
if ! command -v jq >/dev/null 2>&1; then
  echo "  Warn: jq missing — skip JSON cleanup"
else
  CD="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"; AD="$CD/agents"; CF="$CD/opencode.json"
  SPEC="${NEXUS_PLUGIN_SPEC:-nexus@git+https://github.com/mohammad154/opencode-nexus.git}"
  NAG='["orchestrator","implementer","spec-reviewer","code-reviewer","unified-reviewer","blast-analyzer","reconciler"]'
  if [[ -f "$CF" ]]; then
    TJ="$(mktemp)"
    if jq --arg pl "$SPEC" --argjson ns "$NAG" '
      .plugin = ((.plugin // []) | map(select(. != $pl)))
      | reduce $ns[] as $n (.;
          if .agent[$n] then
            .agent[$n] |= del(.model, .reasoningEffort)
            | if .agent[$n] == {} then .agent |= del(.[$n]) else . end
          else . end)
    ' "$CF" >"$TJ"; then
      mv "$TJ" "$CF"
    else
      echo "  Failed to clean $CF"; rm -f "$TJ"
    fi
  fi
  for ag in orchestrator implementer spec-reviewer code-reviewer unified-reviewer blast-analyzer reconciler; do
    t="$AD/$ag.md"; [[ -f "$t" ]] && bak_restore "$t" || rm -f "$t"; rm -f "$AD/nexus-$ag.md"
  done
  rm -f "$CD/nexus.models.example.json"
  echo "  [opencode] Done. Kept $CD/nexus.models.json"
fi

echo ""; echo "Uninstall complete."
echo "Notes: graphify-out/ and Graphify installation are not touched; nexus.models.json kept"
echo "       Project git post-commit hooks are not auto-removed (edit .git/hooks/post-commit if needed)"
