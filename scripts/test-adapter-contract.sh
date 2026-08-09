#!/usr/bin/env bash
# Smoke-test every platform adapter in its own temporary HOME and Git project.
# The installer must never use the source checkout as a project-local target.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPROOT="$(mktemp -d)"
cleanup() { rm -rf "$TMPROOT"; }
trap cleanup EXIT

SANITIZED_PATH="/usr/bin:/bin"
CANONICAL_AGENTS=(orchestrator implementer unified-reviewer spec-reviewer code-reviewer reconciler)

fail() {
  echo "FAIL: $*" >&2
  if [[ -f "${HOME:-}/install.log" ]]; then
    sed -n '1,240p' "$HOME/install.log" >&2 || true
  fi
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "jq is required for the OpenCode adapter smoke test"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required for adapter idempotence snapshots"

SOURCE_STATUS="$(git -C "$ROOT" status --porcelain=v1)"

adapter_roots() {
  local platform="$1" home="$2" project="$3"
  case "$platform" in
    opencode) printf '%s\n' "$home/.config/opencode" ;;
    claude) printf '%s\n' "$home/.claude" "$project/.claude" ;;
    cursor) printf '%s\n' "$home/.cursor" "$project/.cursor" ;;
    codex) printf '%s\n' "$home/.codex" "$home/.agents" "$project/.codex" "$project/.agents" ;;
    gemini) printf '%s\n' "$home/.gemini" "$home/.agents" "$project/.gemini" "$project/.agents" ;;
    antigravity) printf '%s\n' "$home/.antigravity" "$home/.gemini" "$home/.agents" "$project/.antigravity" "$project/.gemini" "$project/.agents" ;;
  esac
}

snapshot_artifacts() {
  local platform="$1" home="$2" project="$3" output="$4" file rel
  : >"$output"
  while IFS= read -r root; do
    [[ -d "$root" ]] || continue
    find "$root" -type f ! -name '*.bak.*' \( -name 'nexus*' -o -name 'opencode.json' \) -print
  done < <(adapter_roots "$platform" "$home" "$project") | sort -u | while IFS= read -r file; do
    rel="${file#"$home"/}"
    [[ "$rel" == "$file" ]] && rel="project/${file#"$project"/}"
    printf '%s\t%s\n' "$rel" "$(sha256sum "$file" | awk '{print $1}')"
  done >"$output"
}

assert_adapter_clean() {
  local platform="$1" home="$2" project="$3" file
  while IFS= read -r root; do
    [[ -d "$root" ]] || continue
    if find "$root" ! -name '*.bak.*' \( -name 'nexus*' -o -name 'nexus.md' \) -print -quit | grep -q .; then
      fail "$platform uninstall left Nexus adapter artifacts under $root"
    fi
  done < <(adapter_roots "$platform" "$home" "$project")
  if [[ "$platform" == opencode && -f "$home/.config/opencode/opencode.json" ]]; then
    jq -e --arg spec 'nexus@git+https://github.com/mohammad154/opencode-nexus.git' \
      '((.plugin // []) | map(select(. == $spec)) | length) == 0' \
      "$home/.config/opencode/opencode.json" >/dev/null \
      || fail "OpenCode uninstall left a duplicate Nexus plugin entry"
  fi
}

smoke_platform() (
  set -euo pipefail
  local platform="$1"
  local home="$TMPROOT/$platform"
  local project="$home/project"
  local agent_root=""
  local skill_root=""
  local agent_file=""

  mkdir -p "$home/bin" "$project" "$home/.config/opencode"
  # Keep project-local adapter writes in scope only for Antigravity, whose
  # contract explicitly includes .agents/rules and .agents/workflows. The
  # other adapters are validated at their user roots; this also ensures the
  # current uninstaller's user-path cleanup is tested without hiding a
  # project-agent compatibility gap.
  if [[ "$platform" == antigravity ]]; then
    git init -q "$project"
  fi
  printf '{}\n' >"$home/.config/opencode/opencode.json"
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"$GRAPHIFY_LOG"\n' >"$home/bin/graphify"
  chmod +x "$home/bin/graphify"

  export HOME="$home"
  export PATH="$home/bin:$SANITIZED_PATH"
  export GRAPHIFY_LOG="$home/graphify.log"
  unset OPENCODE_CONFIG_DIR CLAUDE_CONFIG_DIR CURSOR_RULES_DIR CURSOR_AGENTS_DIR \
    CURSOR_SKILLS_DIR CODEX_CONFIG_DIR GEMINI_CONFIG_DIR ANTIGRAVITY_CONFIG_DIR \
    NEXUS_PLUGIN_SPEC NEXUS_OPTIONAL_AGENTS

  echo "== adapter smoke: $platform =="
  if ! (cd "$project" && "$ROOT/install.sh" --only "$platform" >"$home/install.log" 2>&1); then
    fail "$platform installer exited non-zero"
  fi

  case "$platform" in
    opencode)
      agent_root="$home/.config/opencode/agents"
      ;;
    claude)
      agent_root="$home/.claude/agents"
      skill_root="$home/.claude/skills"
      ;;
    cursor)
      agent_root="$home/.cursor/agents"
      skill_root="$home/.cursor/skills"
      ;;
    codex)
      agent_root="$home/.codex/agents"
      skill_root="$home/.codex/skills"
      ;;
    gemini)
      agent_root="$home/.gemini/agents"
      skill_root="$home/.gemini/skills"
      ;;
    antigravity)
      agent_root="$home/.antigravity/agents"
      skill_root="$home/.antigravity/skills"
      ;;
    *) fail "unknown adapter test target: $platform" ;;
  esac

  snapshot_artifacts "$platform" "$home" "$project" "$home/adapter-before-second-install.txt"
  if ! (cd "$project" && "$ROOT/install.sh" --only "$platform" >"$home/install-second.log" 2>&1); then
    fail "$platform second installer invocation exited non-zero"
  fi
  snapshot_artifacts "$platform" "$home" "$project" "$home/adapter-after-second-install.txt"
  cmp -s "$home/adapter-before-second-install.txt" "$home/adapter-after-second-install.txt" \
    || fail "$platform second install changed the adapter artifact set"

  for agent in "${CANONICAL_AGENTS[@]}"; do
    if [[ "$platform" == opencode ]]; then
      agent_file="$agent_root/$agent.md"
    else
      agent_file="$agent_root/nexus-$agent.md"
    fi
    [[ -f "$agent_file" ]] || fail "$platform missing expected agent: $agent_file"
    if [[ "$platform" != opencode ]]; then
      grep -q "^name: nexus-$agent$" "$agent_file" \
        || fail "$platform agent has no translated name: $agent_file"
    fi
  done

  if [[ "$platform" == opencode ]]; then
    [[ ! -e "$agent_root/nexus-orchestrator.md" ]] \
      || fail "OpenCode unexpectedly prefixed its native agent names"
    [[ ! -e "$agent_root/blast-analyzer.md" && ! -e "$agent_root/knowledge-graph.md" ]] \
      || fail "optional compatibility agents installed by default"
    jq -e --arg spec 'nexus@git+https://github.com/mohammad154/opencode-nexus.git' \
      '((.plugin // []) | map(select(. == $spec)) | length) == 1' \
      "$home/.config/opencode/opencode.json" >/dev/null \
      || fail "OpenCode repeated install duplicated the plugin config entry"
    if find "$home" "$project" -type f -path '*/nexus-using-nexus/SKILL.md' -print -quit | grep -q .; then
      fail "OpenCode unexpectedly received a host skill adapter"
    fi
  else
    [[ -f "$skill_root/nexus-using-nexus/SKILL.md" ]] \
      || fail "$platform missing prefixed skill: $skill_root/nexus-using-nexus/SKILL.md"
    grep -q '^name: nexus-using-nexus$' "$skill_root/nexus-using-nexus/SKILL.md" \
      || fail "$platform skill frontmatter was not translated"
  fi

  if find "$home" "$project" -type f \( \
      -name 'blast-analyzer.md' -o -name 'knowledge-graph.md' \
      -o -name 'nexus-blast-analyzer.md' -o -name 'nexus-knowledge-graph.md' \
    \) -print -quit | grep -q .; then
    fail "$platform installed an optional graph/blast agent without an explicit flag"
  fi

  if [[ "$platform" == opencode ]]; then
    grep -q '^install --platform opencode$' "$GRAPHIFY_LOG" \
      || fail "OpenCode installer did not invoke Graphify global skill installation"
    grep -q '^opencode install$' "$GRAPHIFY_LOG" \
      || fail "OpenCode installer did not invoke Graphify project installation"
    [[ -x "$home/bin/graphify" ]] \
      || fail "Nexus uninstall removed the external Graphify executable"
    ! grep -q 'uninstall' "$GRAPHIFY_LOG" \
      || fail "Nexus uninstall invoked a Graphify uninstall command"
  fi

  case "$platform" in
    claude)
      grep -q '^tools: Agent(nexus-' "$home/.claude/agents/nexus-orchestrator.md" \
        || fail "Claude permission/dispatch names were not prefixed"
      ;;
    cursor)
      [[ -f "$home/.cursor/rules/nexus-using-nexus.mdc" ]] \
        || fail "Cursor rules adapter missing"
      grep -q '^alwaysApply: true$' "$home/.cursor/rules/nexus-using-nexus.mdc" \
        || fail "Cursor using-nexus rule is not always-on"
      ;;
    codex)
      [[ -f "$home/.agents/skills/nexus-using-nexus/SKILL.md" ]] \
        || fail "Codex primary skill path missing"
      ;;
    gemini)
      [[ -f "$home/.agents/skills/nexus-using-nexus/SKILL.md" ]] \
        || fail "Gemini shared skill path missing"
      ;;
    antigravity)
      [[ -f "$home/.gemini/config/skills/nexus-using-nexus/SKILL.md" ]] \
        || fail "Antigravity universal skill path missing"
      [[ -f "$project/.agents/rules/nexus.md" ]] \
        || fail "Antigravity project rule adapter missing"
      [[ -f "$project/.agents/workflows/nexus.md" ]] \
        || fail "Antigravity project workflow adapter missing"
      grep -q 'This adapter translates paths' "$project/.agents/rules/nexus.md" \
        || fail "Antigravity rule does not state the adapter contract"
      grep -q 'nexus-using-nexus' "$project/.agents/workflows/nexus.md" \
        || fail "Antigravity workflow does not expose the canonical entrypoint"
      if grep -q 'Review gates\|workflow_profile' "$project/.agents/rules/nexus.md" "$project/.agents/workflows/nexus.md"; then
        fail "Antigravity adapter duplicated workflow policy"
      fi
      ;;
  esac

  if ! (cd "$project" && "$ROOT/uninstall.sh" --only "$platform" >"$home/uninstall.log" 2>&1); then
    fail "$platform uninstall exited non-zero"
  fi
  assert_adapter_clean "$platform" "$home" "$project"
  echo "PASS: $platform idempotence and uninstall cleanup"

  echo "PASS: $platform adapter paths, prefixes, and host outputs"
)

for platform in opencode claude cursor codex gemini antigravity; do
  smoke_platform "$platform"
done

# Verify that OpenCode restores a pre-existing user agent/config while removing
# only Nexus entries. This uses a separate temporary HOME from the idempotence
# fixture so the backup selected by uninstall is the user's original file.
restore_home="$TMPROOT/opencode-restore"
restore_project="$restore_home/project"
mkdir -p "$restore_home/bin" "$restore_home/.config/opencode/agents" "$restore_project"
git init -q "$restore_project"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"$GRAPHIFY_LOG"\n' >"$restore_home/bin/graphify"
chmod +x "$restore_home/bin/graphify"
printf '{"plugin":["user/plugin"],"agent":{"custom":{"model":"user-model"}}}\n' \
  >"$restore_home/.config/opencode/opencode.json"
printf 'user orchestrator configuration\n' >"$restore_home/.config/opencode/agents/orchestrator.md"
export HOME="$restore_home"
export PATH="$restore_home/bin:$SANITIZED_PATH"
export GRAPHIFY_LOG="$restore_home/graphify.log"
if ! (cd "$restore_project" && "$ROOT/install.sh" --only opencode >"$restore_home/install.log" 2>&1); then
  fail "OpenCode restoration fixture install exited non-zero"
fi
if ! (cd "$restore_project" && "$ROOT/uninstall.sh" --only opencode >"$restore_home/uninstall.log" 2>&1); then
  fail "OpenCode restoration fixture uninstall exited non-zero"
fi
grep -q '^user orchestrator configuration$' "$restore_home/.config/opencode/agents/orchestrator.md" \
  || fail "OpenCode uninstall did not restore the pre-existing agent file"
jq -e '.plugin == ["user/plugin"] and .agent.custom.model == "user-model"' \
  "$restore_home/.config/opencode/opencode.json" >/dev/null \
  || fail "OpenCode uninstall did not preserve pre-existing config entries"
echo "PASS: OpenCode restores pre-existing user config and agent files"

[[ "$(git -C "$ROOT" status --porcelain=v1)" == "$SOURCE_STATUS" ]] \
  || fail "adapter smoke changed the source worktree"

echo "PASS: all six adapters are isolated from the source worktree"
