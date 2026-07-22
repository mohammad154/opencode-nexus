#!/usr/bin/env bash
# Nexus multi-platform installer — Graphify pattern
# Platforms: opencode (CLI), claude (CLI+IDE hooks), cursor (CLI: cursor-agent + IDE rules),
#            codex (CLI), gemini (CLI), antigravity (CLI+IDE, alias: ag)
# Usage: ./install.sh [--only p1[,p2]] [--all] [--uninstall] [-h]
# Deps: bash, jq (opencode path only), git optional
set -euo pipefail

echo "Installing OpenCode Nexus (multi-platform)..."; echo ""

ONLY=""; FORCE_ALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only=*) ONLY="$(echo "${1#--only=}" | tr ',' ' ' | tr 'A-Z' 'a-z')"; shift ;;
    --only)   shift; ONLY="$(echo "${1:-}" | tr ',' ' ' | tr 'A-Z' 'a-z')"; shift || true ;;
    --all)    FORCE_ALL=1; shift ;;
    --uninstall) exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/uninstall.sh" "${@:2}" ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./install.sh [--only p1[,p2]] [--all]
Platforms: opencode, claude, cursor, codex, gemini, antigravity, all  (alias: ag=antigravity)
  --only cursor          Cursor CLI (cursor-agent) + IDE (~/.cursor/rules/*.mdc + project-local)
  --only antigravity     Antigravity (~/.gemini/config/skills + .agents/rules + .agents/workflows)
  --only gemini          Gemini CLI (~/.gemini/skills/<skill>/ one-level deep)
  --only claude,cursor   two platforms
  --all                  force all even if binaries missing
  --uninstall            delegate to uninstall.sh
USAGE
      exit 0 ;;
    *,*) ONLY="$(echo "$1" | tr ',' ' ' | tr 'A-Z' 'a-z')"; shift ;;  # bare csv compat
    *) shift ;;
  esac
done

# normalize aliases
ONLY="$(echo "$ONLY" | tr ' ' '\n' | sed -e 's/^ag$/antigravity/' -e 's/^antigrav$/antigravity/' | tr '\n' ' ' | xargs echo -n "")"

want() { # want <platform> — --only filters; --all only forces missing-binary installs
  local p=$1
  if [[ -n "$ONLY" ]]; then
    grep -qw "$p" <<<"$ONLY" && return 0
    grep -qw "all" <<<"$ONLY" && return 0
    return 1
  fi
  return 0
}

detect() { # detect <platform> — use $HOME not ~ so TMP_HOME isolation tests work
  case $1 in
    opencode)    command -v opencode >/dev/null 2>&1 ;;
    claude)      command -v claude >/dev/null 2>&1 || [[ -d "$HOME/.claude" ]] ;;
    cursor)      command -v cursor-agent >/dev/null 2>&1 || command -v cursor >/dev/null 2>&1 || [[ -d "$HOME/.cursor" || -f ".cursorrules" || -d ".cursor" ]] ;;
    codex)       command -v codex >/dev/null 2>&1 || [[ -d "$HOME/.codex" ]] ;;
    gemini)      command -v gemini >/dev/null 2>&1 || [[ -d "$HOME/.gemini" || -d "$HOME/.config/gemini" ]] ;;
    antigravity) command -v antigravity >/dev/null 2>&1 || command -v ag >/dev/null 2>&1 || [[ -d "$HOME/.antigravity" || -d "$HOME/.config/antigravity" || -d "$HOME/.gemini" ]] || command -v gemini >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

bak() { [[ -f "$1" ]] && cp "$1" "$1.bak.$(date +%Y%m%d%H%M%S)" || true; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
AGENTS_DIR="$CONFIG_DIR/agents"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
MODELS_FILE="$CONFIG_DIR/nexus.models.json"
DEFAULT_MODELS="$SCRIPT_DIR/config/default-models.json"
MODELS_EXAMPLE="$SCRIPT_DIR/config/models.example.json"
PLUGIN_SPEC="${NEXUS_PLUGIN_SPEC:-nexus@git+https://github.com/mohammad154/opencode-nexus.git}"

echo "Platform detection:"
for p in opencode claude cursor codex gemini antigravity; do
  s="not detected"; detect "$p" && s="detected"; (( FORCE_ALL )) && s="$s (forced)"
  if want "$p"; then echo "  $p: $s → will install"; else echo "  $p: $s → skipped (--only)"; fi
done; echo ""

# ── OpenCode ──
if want opencode; then
  echo "[opencode] Installing..."
  if ! command -v opencode >/dev/null 2>&1 && (( ! FORCE_ALL )); then
    echo "  Skip: opencode binary missing (use --all to force)"
  elif ! command -v jq >/dev/null 2>&1; then
    echo "  Error: jq required for opencode path (sudo apt install jq). Other platforms still work."
  else
    mkdir -p "$CONFIG_DIR" "$AGENTS_DIR"
    if [[ -f "$CONFIG_FILE" ]]; then bak "$CONFIG_FILE"; else printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' >"$CONFIG_FILE"; fi
    MJ="$(cat "$DEFAULT_MODELS")"
    if [[ -f "$MODELS_FILE" ]]; then
      MJ="$(jq -s 'def strip: with_entries(select(.key|startswith("_")|not)); .[0]*(.[1]|strip)' "$DEFAULT_MODELS" "$MODELS_FILE")"
    else
      cp "$MODELS_EXAMPLE" "$CONFIG_DIR/nexus.models.example.json"
      echo "  Created $CONFIG_DIR/nexus.models.example.json"
    fi
    for spec in "orchestrator:NEXUS_ORCHESTRATOR_MODEL" "implementer:NEXUS_IMPLEMENTER_MODEL" "spec-reviewer:NEXUS_SPEC_REVIEWER_MODEL" "code-reviewer:NEXUS_CODE_REVIEWER_MODEL"; do
      IFS=: read -r ag envv <<<"$spec"; v="${!envv:-}"; [[ -n "$v" ]] && MJ="$(jq --arg a "$ag" --arg m "$v" '.[$a].model=$m' <<<"$MJ")"
    done
    for spec in "implementer:NEXUS_IMPLEMENTER_REASONING_EFFORT" "spec-reviewer:NEXUS_SPEC_REVIEWER_REASONING_EFFORT" "code-reviewer:NEXUS_CODE_REVIEWER_REASONING_EFFORT"; do
      IFS=: read -r ag envv <<<"$spec"; v="${!envv:-}"; [[ -n "$v" ]] && MJ="$(jq --arg a "$ag" --arg e "$v" '.[$a].reasoningEffort=$e' <<<"$MJ")"
    done
    TMP="$(mktemp)"
    # Keep object context: `.plugin=(...)` would pipe the array and break later merges
    if ! jq --arg p "$PLUGIN_SPEC" --argjson m "$MJ" '
      .plugin = ((.plugin // []) | if index($p) then . else . + [$p] end)
      | .agent = (.agent // {})
      | reduce ($m | keys[]) as $k (.; .agent[$k] = ((.agent[$k] // {}) + $m[$k]))
    ' "$CONFIG_FILE" >"$TMP"; then
      echo "  Error: failed to merge plugin/models into $CONFIG_FILE"
      rm -f "$TMP"
    else
      mv "$TMP" "$CONFIG_FILE"
      for ag in orchestrator implementer spec-reviewer code-reviewer blast-analyzer knowledge-graph reconciler; do
        src="$SCRIPT_DIR/agents/$ag.md"; [[ -f "$src" ]] || continue
        bak "$AGENTS_DIR/$ag.md"; cp "$src" "$AGENTS_DIR/$ag.md"
      done
      echo "  [opencode] Done → $CONFIG_FILE agents: $AGENTS_DIR/"
    fi
  fi
else echo "[opencode] Skipped"; fi

# ── helpers: one-level skill dirs (Claude/Gemini discover only skills/<name>/SKILL.md) ──
skill_desc() { # skill_desc <SKILL.md>
  grep -m1 '^description:' "$1" 2>/dev/null | sed 's/^description:[[:space:]]*//' || basename "$(dirname "$1")"
}
install_skills_flat() { # install_skills_flat <dest_skills_root> [prefix]
  # Writes <root>/<prefix><skill-name>/SKILL.md (+ siblings). One level deep for discovery.
  local root=$1 prefix=${2:-nexus-} sk n d
  [[ -z "$root" ]] && return
  mkdir -p "$root" 2>/dev/null || return
  for sk in "$SCRIPT_DIR"/skills/*; do
    [[ -d "$sk" ]] || continue
    n="$(basename "$sk")"
    d="$root/${prefix}${n}"
    mkdir -p "$d"
    cp -r "$sk"/* "$d"/ 2>/dev/null || true
  done
}
strip_skill_frontmatter() { # stdin → body without YAML frontmatter
  awk 'BEGIN{fm=0} /^---[[:space:]]*$/{if(NR==1){fm=1;next} if(fm==1){fm=2;next}} fm!=1{print}' 
}

# ── Claude Code ──
if want claude; then
  echo ""; echo "[claude] Installing (CLI+IDE)..."
  CD="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; CAD="$CD/agents"; mkdir -p "$CAD"
  # Claude discovers ~/.claude/skills/<name>/SKILL.md (one level — not skills/nexus/<name>)
  install_skills_flat "$CD/skills" "nexus-"
  gt="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "$gt" ]] && install_skills_flat "$gt/.claude/skills" "nexus-"
  for ag in "$SCRIPT_DIR"/agents/*.md; do cp -f "$ag" "$CAD/nexus-$(basename "$ag")" 2>/dev/null || true; done
  # Remove obsolete invalid Claude hook artifact from older installers
  # (Claude Code has no post-commit event; use scripts/install-git-hook.sh in a consumer repo)
  rm -f "$CD/hooks/nexus-graph.json" 2>/dev/null || true
  echo "  [claude] Done → $CD/skills/nexus-*/ + $CAD/nexus-*.md"
  echo "  Tip: in a project repo, run scripts/install-git-hook.sh to refresh the graph on commit"
fi

# ── Cursor (CLI cursor-agent/cursor + IDE) ──
if want cursor; then
  echo ""; echo "[cursor] Installing (CLI + IDE)..."
  CUR_R="${CURSOR_RULES_DIR:-$HOME/.cursor/rules}"; CUR_A="${CURSOR_AGENTS_DIR:-$HOME/.cursor/agents}"; mkdir -p "$CUR_R" "$CUR_A"
  GIT_TOP="$(git rev-parse --show-toplevel 2>/dev/null || true)"; PROJ_R=""; [[ -n "$GIT_TOP" ]] && PROJ_R="$GIT_TOP/.cursor/rules"
  for sk in "$SCRIPT_DIR"/skills/*; do
    [[ -d "$sk" ]] || continue; n="$(basename "$sk")"; s="$sk/SKILL.md"; [[ -f "$s" ]] || continue
    dst="$CUR_R/nexus-$n.mdc"; bak "$dst"
    desc="$(skill_desc "$s")"
    # Agent-requested rule: description only (no globs) — Cursor attaches when relevant
    # using-nexus is the session router → alwaysApply
    if [[ "$n" == "using-nexus" ]]; then
      { echo "---"; echo "description: $desc"; echo "alwaysApply: true"; echo "---"; echo ""; strip_skill_frontmatter <"$s"; } >"$dst"
    else
      { echo "---"; echo "description: $desc"; echo "alwaysApply: false"; echo "---"; echo ""; strip_skill_frontmatter <"$s"; } >"$dst"
    fi
    if [[ -n "$PROJ_R" && "$PROJ_R" != "$CUR_R" ]]; then
      mkdir -p "$PROJ_R" 2>/dev/null || true
      if [[ ! -f "$PROJ_R/nexus-$n.mdc" || $FORCE_ALL -eq 1 ]]; then
        cp -f "$dst" "$PROJ_R/nexus-$n.mdc" 2>/dev/null || true
      fi
    fi
  done
  for ag in "$SCRIPT_DIR"/agents/*.md; do cp -f "$ag" "$CUR_A/nexus-$(basename "$ag")" 2>/dev/null || true; done
  echo "  [cursor] Done → global: $CUR_R/nexus-*.mdc + agents: $CUR_A/nexus-*.md"
  [[ -n "$PROJ_R" ]] && echo "         project-local: $PROJ_R/nexus-*.mdc"
fi

# ── Codex (recursive **/SKILL.md — flat nexus-* dirs for consistent names) ──
if want codex; then
  echo ""; echo "[codex] Installing (CLI)..."
  COD="${CODEX_CONFIG_DIR:-$HOME/.codex}/skills"
  install_skills_flat "$COD" "nexus-"
  echo "  [codex] Done → $COD/nexus-*/"
fi

# ── Gemini CLI: ~/.gemini/skills/<name>/SKILL.md (one level; NOT config/skills, NOT nested nexus/) ──
if want gemini; then
  echo ""; echo "[gemini] Installing (CLI: gemini)..."
  for base in "${GEMINI_CONFIG_DIR:-$HOME/.gemini}" "$HOME/.config/gemini"; do
    install_skills_flat "$base/skills" "nexus-"
  done
  # Cross-framework Agent Skills locations
  install_skills_flat "${HOME}/.agents/skills" "nexus-"
  gt="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$gt" ]]; then
    install_skills_flat "$gt/.gemini/skills" "nexus-"
    install_skills_flat "$gt/.agents/skills" "nexus-"
  fi
  echo "  [gemini] Done → ~/.gemini/skills/nexus-*/ (+ ~/.agents/skills/nexus-*/)"
fi

# ── Antigravity: global ~/.gemini/config/skills/<name>/ + project .agents/rules + .agents/workflows ──
if want antigravity; then
  echo ""; echo "[antigravity] Installing (IDE + Gemini config/skills)..."
  # Antigravity global skill path (Graphify-compatible)
  for b in "${GEMINI_CONFIG_DIR:-$HOME/.gemini}" "$HOME/.config/gemini"; do
    install_skills_flat "$b/config/skills" "nexus-"
  done
  # Legacy AG home (best-effort)
  for b in "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.antigravity}" "$HOME/.config/antigravity"; do
    install_skills_flat "$b/skills" "nexus-"
    mkdir -p "$b/agents" 2>/dev/null || true
    for ag in "$SCRIPT_DIR"/agents/*.md; do cp -f "$ag" "$b/agents/nexus-$(basename "$ag")" 2>/dev/null || true; done
  done
  gt="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$gt" ]]; then
    install_skills_flat "$gt/.gemini/config/skills" "nexus-"
    # Always-on rules + slash workflow (Graphify Antigravity pattern: .agents/rules + .agents/workflows)
    mkdir -p "$gt/.agents/rules" "$gt/.agents/workflows"
    {
      echo "# Nexus (always-on)"
      echo ""
      echo "You have OpenCode Nexus multi-agent workflow skills installed as \`nexus-*\`."
      echo "Prefer the Nexus router: load skill \`nexus-using-nexus\` for phase routing."
      echo "Before implementing, run blast-radius; keep durable state under \`.opencode/\`."
      echo "Skills live under \`.gemini/config/skills/nexus-*/\` and \`.agents/skills/nexus-*/\` when present."
    } >"$gt/.agents/rules/nexus.md"
    {
      echo "---"
      echo "description: Run Nexus orchestrated workflow (plan → graph → blast → implement → review)"
      echo "---"
      echo ""
      echo "Invoke the Nexus workflow for the current request."
      echo "1. Load \`nexus-using-nexus\` routing guidance."
      echo "2. Ensure knowledge graph via \`scripts/nexus-graph.sh\` when useful."
      echo "3. Blast-before-implement via \`scripts/nexus-blast.js\`."
      echo "4. Persist plan/context/handoffs under \`.opencode/\`."
    } >"$gt/.agents/workflows/nexus.md"
    echo "  Project AG: $gt/.agents/rules/nexus.md + $gt/.agents/workflows/nexus.md"
  fi
  echo "  [antigravity] Done → ~/.gemini/config/skills/nexus-*/ (+ .agents/rules|workflows)"
fi

# ── scripts check ──
echo ""; echo "[scripts] Checking:"
for s in nexus-graph.sh nexus-graph.js nexus-blast.sh nexus-blast.js install-git-hook.sh; do if [[ -f "$SCRIPT_DIR/scripts/$s" ]]; then echo "  ✓ scripts/$s"; else echo "  ✗ missing $s"; fi; done
chmod +x "$SCRIPT_DIR/scripts/nexus-graph.sh" "$SCRIPT_DIR/scripts/nexus-blast.sh" "$SCRIPT_DIR/scripts/install-git-hook.sh" 2>/dev/null || true
chmod a+r "$SCRIPT_DIR/scripts/nexus-graph.js" "$SCRIPT_DIR/scripts/nexus-blast.js" 2>/dev/null || true

cat <<END

Installation complete.
Supported (auto-detect):
  • opencode    CLI → ~/.config/opencode/ (plugin + agents)
  • claude      CLI+IDE → ~/.claude/skills/nexus-*/ (git hook: scripts/install-git-hook.sh)
  • cursor      CLI+IDE → ~/.cursor/rules/nexus-*.mdc + <repo>/.cursor/rules/
  • codex       CLI → ~/.codex/skills/nexus-*/
  • gemini      CLI → ~/.gemini/skills/nexus-*/ (+ ~/.agents/skills/)
  • antigravity IDE → ~/.gemini/config/skills/nexus-*/ + <repo>/.agents/rules|workflows/
Next:
  - ./scripts/nexus-graph.sh && ls .opencode/knowledge/
  - node ./scripts/nexus-blast.js --mermaid
  - opencode: restart, select orchestrator
  - claude: restart, ask 'use the nexus knowledge-graph skill'
  - cursor: restart or run cursor-agent (rules auto-loaded)
  - antigravity: restart; use /nexus workflow or rules
  - codex/gemini: run 'codex'/'gemini' with task
  - Customize: edit $CONFIG_DIR/nexus.models.json && re-run install.sh
Granular:
  ./install.sh --only cursor | --only antigravity | --only claude,cursor | --all
Uninstall:
  ./uninstall.sh [--only p1[,p2]] [--all]
END
