#!/usr/bin/env bash
# Nexus multi-platform uninstaller — mirrors install.sh
# Platforms: opencode, claude, cursor, codex, gemini, antigravity, all (ag=antigravity alias)
# Usage: ./uninstall.sh [--only p1[,p2]] [--all] [-h]
set -euo pipefail

echo "Uninstalling OpenCode Nexus (multi-platform)..."

ONLY=""; FORCE_ALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only=*) ONLY="${1#--only=}"; shift ;;
    --only)
      shift
      if [[ $# -eq 0 || "$1" == -* ]]; then
        echo "Error: --only requires a platform list (e.g. --only opencode)" >&2
        exit 1
      fi
      ONLY="$1"
      shift
      ;;
    --all) FORCE_ALL=1; shift ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./uninstall.sh [--only p1[,p2]] [--all]
Platforms: opencode, claude, cursor, codex, gemini, antigravity, all (alias: ag=antigravity)
  --only opencode     only OpenCode
  --only cursor       only Cursor CLI+IDE
  --only antigravity  only Antigravity (Gemini CLI skills kept unless --only gemini/--all)
  --all               remove from all known platform paths
USAGE
      exit 0 ;;
    *,*) ONLY="$1"; shift ;;
    *)
      echo "Error: unknown argument: $1 (use --only PLATFORM or --help)" >&2
      exit 1
      ;;
  esac
done

normalize_only() {
  local raw="$1" t out=()
  raw="$(echo "$raw" | tr ',A-Z' ' a-z')"
  for t in $raw; do
    case "$t" in
      ag|antigrav) out+=(antigravity) ;;
      opencode|claude|cursor|codex|gemini|antigravity|all) out+=("$t") ;;
      "") ;;
      *)
        echo "Error: unknown platform in --only: '$t'" >&2
        exit 1
        ;;
    esac
  done
  # Always return 0: empty --only is valid. A failing ((0)) under set -e
  # inside command substitution would abort the whole uninstaller.
  if ((${#out[@]})); then
    printf '%s' "${out[*]}"
  fi
  return 0
}
ONLY="$(normalize_only "$ONLY")"

want() {
  local p=$1 x
  if [[ -n "$ONLY" ]]; then
    for x in $ONLY; do
      [[ "$x" == "$p" || "$x" == "all" ]] && return 0
    done
    return 1
  fi
  # No --only: uninstall all platforms (same as historical behavior)
  return 0
}

if [[ -n "$ONLY" ]]; then
  echo "Strict --only allowlist: $ONLY"
fi

bak_restore() {
  local t=$1; local latest; latest="$(ls -t "$t".bak.* 2>/dev/null | head -1 || true)"
  if [[ -n "$latest" ]]; then mv "$latest" "$t"; elif [[ -f "$t.bak" ]]; then mv "$t.bak" "$t"; else rm -f "$t"; fi
}

rm_nexus_skills() { # rm_nexus_skills <skills_root>
  local root=$1
  [[ -d "$root" ]] || return 0
  rm -rf "$root"/nexus "$root"/nexus-* 2>/dev/null || true
}

if want opencode; then
  echo ""; echo "[opencode] Removing..."
  if ! command -v jq >/dev/null 2>&1; then
    echo "  Warn: jq missing — skip JSON cleanup"
  else
    CD="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"; AD="$CD/agents"; CF="$CD/opencode.json"
    SPEC="${NEXUS_PLUGIN_SPEC:-nexus@git+https://github.com/mohammad154/opencode-nexus.git}"
    NAG='["orchestrator","implementer","spec-reviewer","code-reviewer","blast-analyzer","knowledge-graph","reconciler"]'
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
    for ag in orchestrator implementer spec-reviewer code-reviewer blast-analyzer knowledge-graph reconciler; do
      t="$AD/$ag.md"; [[ -f "$t" ]] && bak_restore "$t" || rm -f "$t"; rm -f "$AD/nexus-$ag.md"
    done
    rm -f "$CD/nexus.models.example.json"
    echo "  [opencode] Done. Kept $CD/nexus.models.json"
  fi
else echo "[opencode] Skipped"; fi

if want claude; then
  echo ""; echo "[claude] Removing..."
  CD="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  rm_nexus_skills "$CD/skills"
  rm -rf "$CD/hooks/nexus" 2>/dev/null || true
  rm -f "$CD/hooks/nexus-graph.json" 2>/dev/null || true
  rm -f "$CD"/agents/nexus-*.md 2>/dev/null || true
  GT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "$GT" ]] && rm_nexus_skills "$GT/.claude/skills"
  echo "  [claude] Removed $CD/skills/nexus-* + agents/nexus-*.md"
fi

if want cursor; then
  echo ""; echo "[cursor] Removing (CLI+IDE)..."
  CR="${CURSOR_RULES_DIR:-$HOME/.cursor/rules}"
  rm -f "$CR"/nexus-*.mdc "$CR"/nexus-*.md 2>/dev/null || true
  rm -f "$HOME/.cursor/agents"/nexus-*.md 2>/dev/null || true
  rm_nexus_skills "${CURSOR_SKILLS_DIR:-$HOME/.cursor/skills}"
  GT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$GT" ]]; then
    rm -f "$GT/.cursor/rules"/nexus-*.mdc 2>/dev/null || true
    rm -f "$GT/.cursor/agents"/nexus-*.md 2>/dev/null || true
    rm_nexus_skills "$GT/.cursor/skills"
    echo "  [cursor] Also cleaned $GT/.cursor/{rules,skills,agents}"
  fi
  echo "  [cursor] Removed $CR/nexus-*.mdc + agents + skills"
fi

if want codex; then
  echo ""; echo "[codex] Removing..."
  rm_nexus_skills "${CODEX_CONFIG_DIR:-$HOME/.codex}/skills"
  rm -f "${CODEX_CONFIG_DIR:-$HOME/.codex}"/agents/nexus-*.md 2>/dev/null || true
  # Shared USER skills path — only remove nexus-* (gemini/cursor may share)
  rm_nexus_skills "${HOME}/.agents/skills"
  GT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$GT" ]]; then
    rm_nexus_skills "$GT/.agents/skills"
    rm_nexus_skills "$GT/.codex/skills"
    rm -f "$GT/.codex"/agents/nexus-*.md 2>/dev/null || true
  fi
  echo "  [codex] Removed ~/.codex/skills/nexus-*/ + ~/.agents/skills/nexus-*/"
fi

if want gemini; then
  echo ""; echo "[gemini] Removing..."
  for b in "${GEMINI_CONFIG_DIR:-$HOME/.gemini}" "$HOME/.config/gemini"; do
    rm_nexus_skills "$b/skills"
    rm -rf "$b/skills/nexus" "$b/config/skills/nexus" 2>/dev/null || true
    rm -f "$b"/agents/nexus-*.md 2>/dev/null || true
  done
  rm_nexus_skills "${HOME}/.agents/skills"
  rm -f "${HOME}/.agents"/agents/nexus-*.md 2>/dev/null || true
  GT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$GT" ]]; then
    rm_nexus_skills "$GT/.gemini/skills"
    rm_nexus_skills "$GT/.agents/skills"
    rm -rf "$GT/.gemini/skills/nexus" "$GT/.gemini/config/skills/nexus" 2>/dev/null || true
    rm -f "$GT/.agents"/agents/nexus-*.md 2>/dev/null || true
  fi
  echo "  [gemini] Removed ~/.gemini/skills/nexus-* (+ agents + ~/.agents/skills/nexus-*)"
fi

if want antigravity; then
  echo ""; echo "[antigravity] Removing..."
  for b in "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.antigravity}" "$HOME/.config/antigravity"; do
    rm_nexus_skills "$b/skills"
    rm -rf "$b/skills/nexus" "$b/config/skills/nexus" 2>/dev/null || true
    rm -f "$b"/agents/nexus-*.md 2>/dev/null || true
  done
  for b in "${GEMINI_CONFIG_DIR:-$HOME/.gemini}" "$HOME/.config/gemini"; do
    rm_nexus_skills "$b/config/skills"
    rm_nexus_skills "$b/antigravity/skills"
    rm -rf "$b/config/skills/nexus" 2>/dev/null || true
  done
  GT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$GT" ]]; then
    rm_nexus_skills "$GT/.antigravity/skills"
    rm_nexus_skills "$GT/.gemini/config/skills"
    rm_nexus_skills "$GT/.agents/skills"
    rm_nexus_skills "$GT/.agent/skills"
    rm -f "$GT/.antigravity"/agents/nexus-*.md 2>/dev/null || true
    rm -f "$GT/.agents/rules/nexus.md" "$GT/.agents/workflows/nexus.md" 2>/dev/null || true
    rm -f "$GT/.agent/workflows/nexus.md" 2>/dev/null || true
  fi
  echo "  [antigravity] Removed AG skills + .agents/rules|workflows/nexus.md"
  (( FORCE_ALL )) || echo "  Note: Gemini CLI ~/.gemini/skills kept. Use '--only gemini' or --all to remove."
fi

echo ""; echo "Uninstall complete. Cleaned: ${ONLY:-all (auto)}"
echo "Notes: .opencode/knowledge/ + .opencode/handoffs/ not touched; nexus.models.json kept"
echo "       Project git post-commit hooks are not auto-removed (edit .git/hooks/post-commit if needed)"
