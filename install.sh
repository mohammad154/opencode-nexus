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
    --uninstall) exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/uninstall.sh" "${@:2}" ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./install.sh [--only p1[,p2]] [--all]
Platforms: opencode, claude, cursor, codex, gemini, antigravity, all  (alias: ag=antigravity)
  --only opencode        ONLY OpenCode (never touches Claude/Cursor/Gemini/Antigravity)
  --only cursor          Cursor CLI (cursor-agent) + IDE (~/.cursor/rules/*.mdc + project-local)
  --only antigravity     Antigravity (~/.gemini/config/skills + .agents/rules + .agents/workflows)
  --only gemini          Gemini CLI (~/.gemini/skills/<skill>/ one-level deep)
  --only claude,cursor   two platforms
  --all                  force all even if binaries missing
  --uninstall            delegate to uninstall.sh

With no --only: auto-detect each platform independently and install for every detected one.
USAGE
      exit 0 ;;
    *,*) ONLY="$1"; shift ;;  # bare csv compat: ./install.sh opencode,claude
    *)
      echo "Error: unknown argument: $1 (use --only PLATFORM or --help)" >&2
      exit 1
      ;;
  esac
done

# Normalize ONLY → space-separated canonical platform names (no leading/trailing space)
# Do NOT use `xargs echo -n ""` — that prefixes a blank arg and can confuse matching.
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
        echo "Allowed: opencode claude cursor codex gemini antigravity all" >&2
        exit 1
        ;;
    esac
  done
  # Always return 0: empty --only is valid (auto-detect). A failing ((0)) under
  # set -e inside command substitution would abort the whole installer.
  if ((${#out[@]})); then
    printf '%s' "${out[*]}"
  fi
  return 0
}
ONLY="$(normalize_only "$ONLY")"

want() { # want <platform> — --only is an explicit allowlist; never install outside it
  local p=$1 x
  if [[ -n "$ONLY" ]]; then
    for x in $ONLY; do
      [[ "$x" == "$p" || "$x" == "all" ]] && return 0
    done
    return 1
  fi
  return 0
}

# Install only if allowlisted AND (detected, --all, or explicit --only for that platform).
# --only is an allowlist AND an explicit install request for listed platforms.
# Without --only: auto-detect only (never silently write Antigravity/Claude/Cursor trees).
should_install() {
  local p=$1
  want "$p" || return 1
  (( FORCE_ALL )) && return 0
  [[ -n "$ONLY" ]] && return 0
  detect "$p"
}

detect() { # detect <platform> — use $HOME not ~ so TMP_HOME isolation tests work
  # IMPORTANT: do NOT treat unrelated tools as Antigravity.
  # - `ag` is often The Silver Searcher, not Antigravity
  # - Gemini CLI / ~/.gemini must NOT imply Antigravity
  case $1 in
    opencode)    command -v opencode >/dev/null 2>&1 ;;
    claude)      command -v claude >/dev/null 2>&1 || [[ -d "$HOME/.claude" ]] ;;
    cursor)      command -v cursor-agent >/dev/null 2>&1 || command -v cursor >/dev/null 2>&1 || [[ -d "$HOME/.cursor" || -f "$HOME/.cursorrules" ]] ;;
    # Note: do not treat a relative ./.cursor in the installer checkout as "Cursor is installed"
    codex)       command -v codex >/dev/null 2>&1 || [[ -d "$HOME/.codex" ]] ;;
    gemini)      command -v gemini >/dev/null 2>&1 || [[ -d "$HOME/.gemini/skills" || -d "$HOME/.config/gemini" ]] ;;
    antigravity)
      # Real Antigravity only — never treat `ag` (silver searcher), `gemini`, or bare ~/.gemini as AG
      command -v antigravity >/dev/null 2>&1 \
        || command -v agy >/dev/null 2>&1 \
        || [[ -d "$HOME/.antigravity" \
           || -d "$HOME/.config/antigravity" \
           || -d "$HOME/.gemini/antigravity" \
           || -d "$HOME/.gemini/antigravity-cli" ]]
      ;;
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
  s="not detected"
  detect "$p" && s="detected" || true
  if (( FORCE_ALL )); then s="$s (forced)"; fi
  if ! want "$p"; then
    echo "  $p: $s → skipped (--only)"
  elif should_install "$p"; then
    if [[ -n "$ONLY" && "$s" == "not detected" ]]; then
      echo "  $p: $s → will install (--only)"
    else
      echo "  $p: $s → will install"
    fi
  else
    echo "  $p: $s → skipped (not detected; use --all or --only $p to force)"
  fi
done
if [[ -n "$ONLY" ]]; then
  echo ""
  echo "Strict --only allowlist: $ONLY"
  echo "No other platforms will be installed or modified."
fi
echo ""

# ── OpenCode ──
if should_install opencode; then
  echo "[opencode] Installing..."
  if ! command -v jq >/dev/null 2>&1; then
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
# Rewrite frontmatter name: to match folder (Cursor/Codex/Gemini require name == parent folder)
rewrite_skill_name() { # rewrite_skill_name <SKILL.md> <new-name>
  local f=$1 new=$2
  [[ -f "$f" ]] || return 0
  if grep -q '^name:' "$f" 2>/dev/null; then
    sed "s/^name:[[:space:]]*.*/name: $new/" "$f" >"$f.tmp" && mv "$f.tmp" "$f"
  else
    # Insert name after opening ---
    awk -v n="$new" 'BEGIN{done=0} /^---[[:space:]]*$/{print; if(!done){print "name: " n; done=1; next}} {print}' "$f" >"$f.tmp" && mv "$f.tmp" "$f"
  fi
}
install_skills_flat() { # install_skills_flat <dest_skills_root> [prefix]
  # Writes <root>/<prefix><skill-name>/SKILL.md (+ siblings). One level deep for discovery.
  local root=$1 prefix=${2:-nexus-} sk n d skill_name
  [[ -z "$root" ]] && return
  mkdir -p "$root" 2>/dev/null || return
  for sk in "$SCRIPT_DIR"/skills/*; do
    [[ -d "$sk" ]] || continue
    n="$(basename "$sk")"
    skill_name="${prefix}${n}"
    d="$root/${skill_name}"
    mkdir -p "$d"
    cp -r "$sk"/* "$d"/ 2>/dev/null || true
    [[ -f "$d/SKILL.md" ]] && rewrite_skill_name "$d/SKILL.md" "$skill_name"
  done
}
strip_skill_frontmatter() { # stdin → body without YAML frontmatter
  awk 'BEGIN{fm=0} /^---[[:space:]]*$/{if(NR==1){fm=1;next} if(fm==1){fm=2;next}} fm!=1{print}' 
}
agent_body() { # agent_body <src.md> → markdown body after frontmatter
  strip_skill_frontmatter <"$1"
}
agent_desc() { # agent_desc <src.md>
  grep -m1 '^description:' "$1" 2>/dev/null | sed 's/^description:[[:space:]]*//' || basename "$1" .md
}

# OpenCode task-permission rewrite for prefixed agent names (orchestrator allow-list)
rewrite_opencode_task_keys() { # stdin → stdout
  sed -E \
    -e 's/^([[:space:]]+)implementer: allow/\1nexus-implementer: allow/' \
    -e 's/^([[:space:]]+)spec-reviewer: allow/\1nexus-spec-reviewer: allow/' \
    -e 's/^([[:space:]]+)code-reviewer: allow/\1nexus-code-reviewer: allow/' \
    -e 's/^([[:space:]]+)blast-analyzer: allow/\1nexus-blast-analyzer: allow/' \
    -e 's/^([[:space:]]+)knowledge-graph: allow/\1nexus-knowledge-graph: allow/' \
    -e 's/^([[:space:]]+)reconciler: allow/\1nexus-reconciler: allow/' \
    -e 's/@implementer\b/@nexus-implementer/g' \
    -e 's/@spec-reviewer\b/@nexus-spec-reviewer/g' \
    -e 's/@code-reviewer\b/@nexus-code-reviewer/g' \
    -e 's/@blast-analyzer\b/@nexus-blast-analyzer/g' \
    -e 's/@knowledge-graph\b/@nexus-knowledge-graph/g' \
    -e 's/@reconciler\b/@nexus-reconciler/g'
}

# Claude Code: name+description required; tools allowlist (docs: code.claude.com/docs/en/sub-agents)
# Reviewers need Write for .opencode/handoffs/*.json only (enforced in prompt body).
install_claude_agent() { # install_claude_agent <src.md> <dest.md>
  local src=$1 dest=$2 base name desc tools
  [[ -f "$src" ]] || return 0
  base="$(basename "$src" .md)"
  name="nexus-$base"
  desc="$(agent_desc "$src")"
  case "$base" in
    orchestrator)
      # Claude Agent tool allowlist — only Nexus subagents (docs: Agent(name1, name2))
      tools="Agent(nexus-implementer, nexus-spec-reviewer, nexus-code-reviewer, nexus-blast-analyzer, nexus-knowledge-graph, nexus-reconciler), Read, Grep, Glob, Bash, Write, Edit, Skill"
      ;;
    implementer)
      tools="Read, Grep, Glob, Bash, Edit, Write"
      ;;
    spec-reviewer|code-reviewer|blast-analyzer|knowledge-graph|reconciler)
      tools="Read, Grep, Glob, Bash, Write"
      ;;
    *)
      tools="Read, Grep, Glob, Bash, Write"
      ;;
  esac
  {
    echo "---"
    echo "name: $name"
    echo "description: $desc"
    echo "tools: $tools"
    echo "model: inherit"
    echo "---"
    echo ""
    agent_body "$src" | rewrite_opencode_task_keys
  } >"$dest"
}

# Cursor: name + description; filename also used. OpenCode permission keys ignored by Cursor.
# Docs: cursor.com/docs/subagents — do NOT set readonly on reviewers (need handoff JSON writes).
install_cursor_agent() { # install_cursor_agent <src.md> <dest.md>
  local src=$1 dest=$2 base name desc
  [[ -f "$src" ]] || return 0
  base="$(basename "$src" .md)"
  name="nexus-$base"
  desc="$(agent_desc "$src")"
  {
    echo "---"
    echo "name: $name"
    echo "description: $desc"
    echo "model: inherit"
    echo "---"
    echo ""
    # Keep OpenCode permission block as documentation for dual-use; Cursor ignores unknown keys
    # but we strip mode/permission to avoid confusion and rely on prompt constraints.
    agent_body "$src" | rewrite_opencode_task_keys
  } >"$dest"
}

# Generic prefixed copy (Codex/AG best-effort agents) — adds name: for Cursor/Claude compat readers
install_prefixed_agent() { # install_prefixed_agent <src.md> <dest.md>
  local src=$1 dest=$2
  [[ -f "$src" ]] || return 0
  install_cursor_agent "$src" "$dest"
}

install_prefixed_agents_dir() { # install_prefixed_agents_dir <dest_agents_dir>
  local dest=$1 ag
  [[ -z "$dest" ]] && return
  mkdir -p "$dest" 2>/dev/null || return
  for ag in "$SCRIPT_DIR"/agents/*.md; do
    [[ -f "$ag" ]] || continue
    install_prefixed_agent "$ag" "$dest/nexus-$(basename "$ag")"
  done
}

install_claude_agents_dir() {
  local dest=$1 ag
  [[ -z "$dest" ]] && return
  mkdir -p "$dest" 2>/dev/null || return
  for ag in "$SCRIPT_DIR"/agents/*.md; do
    [[ -f "$ag" ]] || continue
    install_claude_agent "$ag" "$dest/nexus-$(basename "$ag")"
  done
}

install_cursor_agents_dir() {
  local dest=$1 ag
  [[ -z "$dest" ]] && return
  mkdir -p "$dest" 2>/dev/null || return
  for ag in "$SCRIPT_DIR"/agents/*.md; do
    [[ -f "$ag" ]] || continue
    install_cursor_agent "$ag" "$dest/nexus-$(basename "$ag")"
  done
}

# ── Claude Code ──
# Docs: skills → ~/.claude/skills/<name>/SKILL.md ; agents → ~/.claude/agents/*.md
# Agents REQUIRE frontmatter name + description (identity = name field, not filename).
if should_install claude; then
  echo ""; echo "[claude] Installing (CLI+IDE)..."
  CD="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; CAD="$CD/agents"; mkdir -p "$CAD"
  install_skills_flat "$CD/skills" "nexus-"
  install_claude_agents_dir "$CAD"
  gt="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$gt" ]]; then
    install_skills_flat "$gt/.claude/skills" "nexus-"
    install_claude_agents_dir "$gt/.claude/agents"
  fi
  rm -f "$CD/hooks/nexus-graph.json" 2>/dev/null || true
  echo "  [claude] Done → $CD/skills/nexus-*/ + $CAD/nexus-*.md (name: frontmatter set)"
  echo "  Tip: in a project repo, run scripts/install-git-hook.sh to refresh the graph on commit"
fi

# ── Cursor (CLI + IDE) ──
# Docs: rules → ~/.cursor/rules/*.mdc ; skills → ~/.cursor/skills/ + ~/.agents/skills/
#        agents → ~/.cursor/agents/*.md (also reads ~/.claude/agents, ~/.codex/agents)
# Agents: name + description; body required after frontmatter.
if should_install cursor; then
  echo ""; echo "[cursor] Installing (CLI + IDE)..."
  CUR_R="${CURSOR_RULES_DIR:-$HOME/.cursor/rules}"; CUR_A="${CURSOR_AGENTS_DIR:-$HOME/.cursor/agents}"
  CUR_S="${CURSOR_SKILLS_DIR:-$HOME/.cursor/skills}"
  mkdir -p "$CUR_R" "$CUR_A" "$CUR_S"
  GIT_TOP="$(git rev-parse --show-toplevel 2>/dev/null || true)"; PROJ_R=""; [[ -n "$GIT_TOP" ]] && PROJ_R="$GIT_TOP/.cursor/rules"
  # Always-on / agent-requested rules (using-nexus alwaysApply)
  for sk in "$SCRIPT_DIR"/skills/*; do
    [[ -d "$sk" ]] || continue; n="$(basename "$sk")"; s="$sk/SKILL.md"; [[ -f "$s" ]] || continue
    dst="$CUR_R/nexus-$n.mdc"; bak "$dst"
    desc="$(skill_desc "$s")"
    if [[ "$n" == "using-nexus" ]]; then
      { echo "---"; echo "description: $desc"; echo "alwaysApply: true"; echo "---"; echo ""; strip_skill_frontmatter <"$s"; } >"$dst"
    else
      { echo "---"; echo "description: $desc"; echo "alwaysApply: false"; echo "---"; echo ""; strip_skill_frontmatter <"$s"; } >"$dst"
    fi
    if [[ "$n" == "orchestrating" ]]; then
      for extra in dispatch.md implementer-prompt.md spec-reviewer-prompt.md code-reviewer-prompt.md branch-cleanup-prompt.md; do
        if [[ -f "$sk/$extra" ]]; then
          { echo ""; echo "---"; echo ""; echo "## Attached: $extra"; echo ""; cat "$sk/$extra"; } >>"$dst"
        fi
      done
    fi
    if [[ -n "$PROJ_R" && "$PROJ_R" != "$CUR_R" ]]; then
      mkdir -p "$PROJ_R" 2>/dev/null || true
      if [[ ! -f "$PROJ_R/nexus-$n.mdc" || $FORCE_ALL -eq 1 ]]; then
        cp -f "$dst" "$PROJ_R/nexus-$n.mdc" 2>/dev/null || true
      fi
    fi
  done
  # Native Agent Skills paths (cursor.com/docs/skills) — name must match folder
  install_skills_flat "$CUR_S" "nexus-"
  install_skills_flat "${HOME}/.agents/skills" "nexus-"
  install_cursor_agents_dir "$CUR_A"
  if [[ -n "$GIT_TOP" ]]; then
    install_skills_flat "$GIT_TOP/.cursor/skills" "nexus-"
    install_skills_flat "$GIT_TOP/.agents/skills" "nexus-"
    install_cursor_agents_dir "$GIT_TOP/.cursor/agents"
  fi
  echo "  [cursor] Done → rules: $CUR_R/nexus-*.mdc + skills: $CUR_S/nexus-*/ + agents: $CUR_A/nexus-*.md"
  [[ -n "$PROJ_R" ]] && echo "         project-local: .cursor/rules|skills|agents + .agents/skills"
fi

# ── Codex ──
# Docs (developers.openai.com/codex/skills): USER=$HOME/.agents/skills ; also ~/.codex/skills (legacy/compat)
# Cursor also loads ~/.codex/skills and .codex/skills
if should_install codex; then
  echo ""; echo "[codex] Installing (CLI)..."
  install_skills_flat "${CODEX_CONFIG_DIR:-$HOME/.codex}/skills" "nexus-"
  install_skills_flat "${HOME}/.agents/skills" "nexus-"
  install_prefixed_agents_dir "${CODEX_CONFIG_DIR:-$HOME/.codex}/agents"
  gt="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$gt" ]]; then
    install_skills_flat "$gt/.agents/skills" "nexus-"
    install_skills_flat "$gt/.codex/skills" "nexus-"
    install_prefixed_agents_dir "$gt/.codex/agents"
  fi
  echo "  [codex] Done → ~/.agents/skills/nexus-*/ + ~/.codex/skills/nexus-*/ (+ agents)"
fi

# ── Gemini CLI ──
# Docs: ~/.gemini/skills/ or ~/.agents/skills/ ; workspace .gemini/skills/ or .agents/skills/
# One level deep only.
if should_install gemini; then
  echo ""; echo "[gemini] Installing (CLI: gemini)..."
  for base in "${GEMINI_CONFIG_DIR:-$HOME/.gemini}" "$HOME/.config/gemini"; do
    install_skills_flat "$base/skills" "nexus-"
    install_prefixed_agents_dir "$base/agents"
  done
  install_skills_flat "${HOME}/.agents/skills" "nexus-"
  install_prefixed_agents_dir "${HOME}/.agents/agents"
  gt="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$gt" ]]; then
    install_skills_flat "$gt/.gemini/skills" "nexus-"
    install_skills_flat "$gt/.agents/skills" "nexus-"
    install_prefixed_agents_dir "$gt/.agents/agents"
  fi
  echo "  [gemini] Done → ~/.gemini/skills/nexus-*/ + ~/.agents/skills/nexus-*/"
fi

# ── Antigravity ──
# Docs (antigravity.google/docs/skills): global ~/.gemini/config/skills/ ; workspace .agents/skills/
# Also recognized: ~/.gemini/antigravity/skills/ (IDE). Universal path: ~/.gemini/config/skills/
if should_install antigravity; then
  echo ""; echo "[antigravity] Installing (IDE + Gemini config/skills)..."
  for b in "${GEMINI_CONFIG_DIR:-$HOME/.gemini}" "$HOME/.config/gemini"; do
    install_skills_flat "$b/config/skills" "nexus-"
    install_skills_flat "$b/antigravity/skills" "nexus-"
  done
  for b in "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.antigravity}" "$HOME/.config/antigravity"; do
    install_skills_flat "$b/skills" "nexus-"
    install_prefixed_agents_dir "$b/agents"
  done
  gt="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$gt" ]]; then
    install_skills_flat "$gt/.gemini/config/skills" "nexus-"
    install_skills_flat "$gt/.agents/skills" "nexus-"
    # Legacy singular .agent/skills still supported by AG
    install_skills_flat "$gt/.agent/skills" "nexus-"
    mkdir -p "$gt/.agents/rules" "$gt/.agents/workflows" "$gt/.agent/workflows"
    {
      echo "# Nexus (always-on)"
      echo ""
      echo "You have OpenCode Nexus multi-agent workflow skills installed as \`nexus-*\`."
      echo "Prefer the Nexus router: load skill \`nexus-using-nexus\` for phase routing."
      echo "Before implementing, run blast-radius; keep durable state under \`.opencode/\`."
      echo "Skills: \`.agents/skills/nexus-*/\` and \`~/.gemini/config/skills/nexus-*/\`."
      echo ""
      echo "## Mandatory two-stage review"
      echo "After implementer finishes: dispatch \`nexus-spec-reviewer\`, wait for APPROVED handoff JSON,"
      echo "then dispatch \`nexus-code-reviewer\`, wait for APPROVED. Never skip either stage."
      echo "See \`nexus-orchestrating/dispatch.md\` for name resolution and jq gates."
    } >"$gt/.agents/rules/nexus.md"
    {
      echo "---"
      echo "description: Run Nexus orchestrated workflow (plan → graph → blast → implement → dual review)"
      echo "---"
      echo ""
      echo "Invoke the Nexus workflow for the current request."
      echo "1. Load \`nexus-using-nexus\` routing guidance."
      echo "2. Ensure knowledge graph via \`scripts/nexus-graph.sh\` when useful."
      echo "3. Blast-before-implement via \`scripts/nexus-blast.js\`."
      echo "4. Persist plan/context/handoffs under \`.opencode/\`."
      echo "5. After implementer: \`nexus-spec-reviewer\` then \`nexus-code-reviewer\` (see dispatch.md)."
      echo "6. Require both APPROVED handoff JSONs before finishing the task."
    } >"$gt/.agents/workflows/nexus.md"
    cp -f "$gt/.agents/workflows/nexus.md" "$gt/.agent/workflows/nexus.md" 2>/dev/null || true
    echo "  Project AG: $gt/.agents/skills + rules/workflows (+ .agent/skills legacy)"
  fi
  echo "  [antigravity] Done → ~/.gemini/config/skills/nexus-*/ + ~/.gemini/antigravity/skills/nexus-*/"
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
