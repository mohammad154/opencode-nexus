#!/usr/bin/env bash
# Smoke-test the OpenCode installer in an isolated temporary HOME and Git project.
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

command -v jq >/dev/null 2>&1 || fail "jq is required for the OpenCode installer smoke test"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required for installer idempotence snapshots"

SOURCE_STATUS=""
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SOURCE_STATUS="$(git -C "$ROOT" status --porcelain=v1)"
fi

snapshot_artifacts() {
  local home="$1" output="$2" file rel
  : >"$output"
  find "$home/.config/opencode" -type f ! -name '*.bak.*' \( -name 'nexus*' -o -name 'opencode.json' \) -print \
    2>/dev/null | sort -u | while IFS= read -r file; do
    rel="${file#"$home"/}"
    printf '%s\t%s\n' "$rel" "$(sha256sum "$file" | awk '{print $1}')"
  done >"$output"
}

assert_opencode_clean() {
  local home="$1"
  if find "$home/.config/opencode" ! -name '*.bak.*' \( -name 'nexus*' -o -name 'nexus.md' \) -print -quit 2>/dev/null | grep -q .; then
    fail "OpenCode uninstall left Nexus artifacts under $home/.config/opencode"
  fi
  if [[ -f "$home/.config/opencode/opencode.json" ]]; then
    jq -e --arg spec 'nexus@git+https://github.com/mohammad154/opencode-nexus.git' \
      '((.plugin // []) | map(select(. == $spec)) | length) == 0' \
      "$home/.config/opencode/opencode.json" >/dev/null \
      || fail "OpenCode uninstall left a duplicate Nexus plugin entry"
  fi
}

echo "== OpenCode installer smoke =="
home="$TMPROOT/opencode"
project="$home/project"
mkdir -p "$home/bin" "$project" "$home/.config/opencode"
printf '{}\n' >"$home/.config/opencode/opencode.json"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"$GRAPHIFY_LOG"\n' >"$home/bin/graphify"
chmod +x "$home/bin/graphify"

export HOME="$home"
export PATH="$home/bin:$SANITIZED_PATH"
export GRAPHIFY_LOG="$home/graphify.log"
unset OPENCODE_CONFIG_DIR NEXUS_PLUGIN_SPEC NEXUS_OPTIONAL_AGENTS

if ! (cd "$project" && "$ROOT/install.sh" >"$home/install.log" 2>&1); then
  fail "OpenCode installer exited non-zero"
fi

snapshot_artifacts "$home" "$home/adapter-before-second-install.txt"
if ! (cd "$project" && "$ROOT/install.sh" >"$home/install-second.log" 2>&1); then
  fail "OpenCode second installer invocation exited non-zero"
fi
snapshot_artifacts "$home" "$home/adapter-after-second-install.txt"
cmp -s "$home/adapter-before-second-install.txt" "$home/adapter-after-second-install.txt" \
  || fail "OpenCode second install changed the artifact set"

agent_root="$home/.config/opencode/agents"
for agent in "${CANONICAL_AGENTS[@]}"; do
  [[ -f "$agent_root/$agent.md" ]] || fail "OpenCode missing expected agent: $agent_root/$agent.md"
done

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

if find "$home" "$project" -type f \( \
    -name 'blast-analyzer.md' -o -name 'knowledge-graph.md' \
    -o -name 'nexus-blast-analyzer.md' -o -name 'nexus-knowledge-graph.md' \
  \) -print -quit | grep -q .; then
  fail "OpenCode installed an optional graph/blast agent without an explicit flag"
fi

grep -q '^install --platform opencode$' "$GRAPHIFY_LOG" \
  || fail "OpenCode installer did not invoke Graphify global skill installation"
grep -q '^opencode install$' "$GRAPHIFY_LOG" \
  || fail "OpenCode installer did not invoke Graphify project installation"
[[ -x "$home/bin/graphify" ]] \
  || fail "Nexus uninstall removed the external Graphify executable"
! grep -q 'uninstall' "$GRAPHIFY_LOG" \
  || fail "Nexus uninstall invoked a Graphify uninstall command"

if ! (cd "$project" && "$ROOT/uninstall.sh" >"$home/uninstall.log" 2>&1); then
  fail "OpenCode uninstall exited non-zero"
fi
assert_opencode_clean "$home"
echo "PASS: OpenCode idempotence and uninstall cleanup"

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
if ! (cd "$restore_project" && "$ROOT/install.sh" >"$restore_home/install.log" 2>&1); then
  fail "OpenCode restoration fixture install exited non-zero"
fi
if ! (cd "$restore_project" && "$ROOT/uninstall.sh" >"$restore_home/uninstall.log" 2>&1); then
  fail "OpenCode restoration fixture uninstall exited non-zero"
fi
grep -q '^user orchestrator configuration$' "$restore_home/.config/opencode/agents/orchestrator.md" \
  || fail "OpenCode uninstall did not restore the pre-existing agent file"
jq -e '.plugin == ["user/plugin"] and .agent.custom.model == "user-model"' \
  "$restore_home/.config/opencode/opencode.json" >/dev/null \
  || fail "OpenCode uninstall did not preserve pre-existing config entries"
echo "PASS: OpenCode restores pre-existing user config and agent files"

if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  [[ "$(git -C "$ROOT" status --porcelain=v1)" == "$SOURCE_STATUS" ]] \
    || fail "installer smoke changed the source worktree"
fi

echo "PASS: OpenCode installer is isolated from the source worktree"
