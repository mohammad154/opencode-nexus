#!/usr/bin/env bash
# OpenCode Nexus uninstaller — mirrors install.sh
# Usage: ./uninstall.sh [-h]
set -euo pipefail

echo "Uninstalling OpenCode Nexus..."

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      cat <<'USAGE'
Usage: ./uninstall.sh
Removes the OpenCode Nexus plugin, agent files, and model example from ~/.config/opencode/.
USAGE
      exit 0 ;;
    *)
      echo "Error: unknown argument: $1 (use --help)" >&2
      exit 1
      ;;
  esac
done

bak_restore() {
  local t=$1
  # Prefer the pristine pre-Nexus original recorded in the install manifest.
  if [[ -n "${MANIFEST_FILE:-}" && -f "$MANIFEST_FILE" ]] && command -v jq >/dev/null 2>&1; then
    local recorded existed backup
    recorded="$(jq -e --arg t "$t" '.files[$t] != null' "$MANIFEST_FILE" 2>/dev/null || true)"
    if [[ "$recorded" == "true" ]]; then
      existed="$(jq -r --arg t "$t" '.files[$t].pre_nexus_existed' "$MANIFEST_FILE" 2>/dev/null || echo "false")"
      backup="$(jq -r --arg t "$t" '.files[$t].original_backup // ""' "$MANIFEST_FILE" 2>/dev/null || echo "")"
      if [[ "$existed" == "true" && -n "$backup" && -f "$backup" ]]; then
        mv "$backup" "$t"
      else
        # File did not exist before Nexus → remove the Nexus-authored file.
        rm -f "$t"
      fi
      # Drop the manifest entry now that provenance is consumed.
      local tmp; tmp="$(mktemp)"
      if jq --arg t "$t" 'del(.files[$t])' "$MANIFEST_FILE" >"$tmp"; then mv "$tmp" "$MANIFEST_FILE"; else rm -f "$tmp"; fi
      return 0
    fi
  fi
  # Fallback (no manifest): oldest .bak is closest to the pre-Nexus original.
  local oldest
  oldest="$(ls -tr "$t".bak.* 2>/dev/null | head -1 || true)"
  if [[ -n "$oldest" ]]; then mv "$oldest" "$t"; elif [[ -f "$t.bak" ]]; then mv "$t.bak" "$t"; else rm -f "$t"; fi
}

CD="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"; AD="$CD/agents"; CF="$CD/opencode.json"
MANIFEST_FILE="$CD/nexus-install-manifest.json"

echo ""; echo "[opencode] Removing..."
if ! command -v jq >/dev/null 2>&1; then
  echo "  Warn: jq missing — skipping opencode.json JSON cleanup only (agent files are still removed/restored)"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PKG_NAME="$(jq -r '.name' "$SCRIPT_DIR/package.json")"
  PKG_VERSION="$(jq -r '.version' "$SCRIPT_DIR/package.json")"
  SPEC="${NEXUS_PLUGIN_SPEC:-${PKG_NAME}@${PKG_VERSION}}"
  LEGACY_GIT_SPEC="nexus@git+https://github.com/mohammad154/opencode-nexus.git"
  NAG='["orchestrator","implementer","reviewer","diagnostician","unified-reviewer","spec-reviewer","code-reviewer","integration-reviewer","reconciler","blast-analyzer"]'
  if [[ -f "$CF" ]]; then
    TJ="$(mktemp)"
    if jq --arg pl "$SPEC" --arg name "$PKG_NAME" --arg legacy "$LEGACY_GIT_SPEC" --argjson ns "$NAG" '
      .plugin = ((.plugin // []) | map(select(
        . != $pl
        and . != $legacy
        and . != $name
        and (startswith($name + "@") | not)
      )))
      | reduce $ns[] as $n (.;
          if .agent[$n] then
            .agent[$n] |= del(.model, .variant, .reasoningEffort)
            | if .agent[$n] == {} then .agent |= del(.[$n]) else . end
          else . end)
    ' "$CF" >"$TJ"; then
      mv "$TJ" "$CF"
    else
      echo "  Failed to clean $CF"; rm -f "$TJ"
    fi
  fi
fi

# Agent file deletion/restoration ALWAYS runs, regardless of jq availability.
for ag in orchestrator implementer reviewer diagnostician unified-reviewer spec-reviewer code-reviewer integration-reviewer reconciler blast-analyzer; do
  t="$AD/$ag.md"; [[ -e "$t" ]] && bak_restore "$t" || true
done
rm -f "$CD/nexus.models.example.json"
# Provenance manifest is consumed during restore; drop it (and any leftover
# pristine originals) so no Nexus bookkeeping files remain.
rm -f "$MANIFEST_FILE"
rm -f "$AD"/*.nexus-original.* 2>/dev/null || true
echo "  [opencode] Done. Kept $CD/nexus.models.json"

echo ""; echo "Uninstall complete."
echo "Notes: project-local .opencode/ is not touched; nexus.models.json kept"
echo "       Project git post-commit hooks are not auto-removed (edit .git/hooks/post-commit if needed)"
