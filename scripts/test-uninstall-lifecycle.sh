#!/usr/bin/env bash
# Regression tests for uninstall lifecycle (fixes #4 and #5):
#   - upgrade → upgrade → upgrade → uninstall restores the USER'S ORIGINAL file
#     (not an intermediate Nexus-authored file), via the install manifest.
#   - uninstall WITHOUT jq still removes/restores agent files (not just JSON).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# --- Test 1: install → upgrade → upgrade → uninstall restores original -------
T1="$(mktemp -d)"
trap 'rm -rf "$T1" "${T2:-}" "${T3:-}" "${T4:-}" "${T5:-}" "${T6:-}" "${T7:-}"' EXIT
(
  export HOME="$T1"
  CD="$HOME/.config/opencode"; AD="$CD/agents"
  mkdir -p "$AD" "$HOME/bin" "$HOME/project"
  printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/opencode"; chmod +x "$HOME/bin/opencode"
  export PATH="$HOME/bin:/usr/bin:/bin"
  printf '{}\n' >"$CD/opencode.json"
  git init -q "$HOME/project"
  for ag in orchestrator implementer reviewer; do
    printf 'ORIGINAL USER %s\n' "$ag" >"$AD/$ag.md"
  done
  for _ in 1 2 3; do
    ( cd "$HOME/project" && "$ROOT/install.sh" ) >/dev/null 2>&1
    sleep 1
  done
  ( cd "$HOME/project" && "$ROOT/uninstall.sh" ) >/dev/null 2>&1
  for ag in orchestrator implementer reviewer; do
    grep -q "^ORIGINAL USER $ag$" "$AD/$ag.md" \
      || { echo "restored $ag was: $(cat "$AD/$ag.md" 2>/dev/null || echo '<missing>')"; exit 1; }
  done
) || fail "upgrade→uninstall did not restore the user's original agent file"
pass "upgrade→upgrade→upgrade→uninstall restores the user's original agent file"

# --- Test 2: full global OpenCode footprint is removed ----------------------
T3="$(mktemp -d)"
(
  export HOME="$T3"
  CD="$HOME/.config/opencode"; AD="$CD/agents"
  mkdir -p "$AD" "$CD/plugins" "$HOME/bin" "$HOME/project"
  printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/opencode"; chmod +x "$HOME/bin/opencode"
  export PATH="$HOME/bin:/usr/bin:/bin"
  git init -q "$HOME/project"
  cat >"$CD/opencode.json" <<'JSON'
{
  "plugin": ["user/plugin"],
  "agent": {
    "orchestrator": {"model": "user/model", "custom": "keep"},
    "custom": {"model": "user-model"}
  },
  "permission": {
    "external_directory": {
      "custom/path/**": "allow",
      "/usr/local/lib/node_modules/@mohammad154/opencode-nexus/**": "deny"
    },
    "skill": {
      "user-skill": "allow",
      "nexus-*": "ask"
    },
    "other": "keep"
  }
  }
JSON
  printf '{"orchestrator":{"model":"user/model"}}\n' >"$CD/nexus.models.json"
  printf 'user-owned model example\n' >"$CD/nexus.models.example.json"
  printf 'ORIGINAL USER ORCHESTRATOR\n' >"$AD/orchestrator.md"
  ln -s "$ROOT/.opencode/plugins/nexus.js" "$CD/plugins/nexus.js"
  printf 'export PATH=/usr/bin\n' >"$HOME/.bashrc"
  CACHE="$HOME/.cache/opencode/packages/@mohammad154"
  mkdir -p "$CACHE/opencode-nexus@4.3.6" "$CACHE/other-package@1.0.0"
  printf 'cached Nexus package\n' >"$CACHE/opencode-nexus@4.3.6/package.json"
  printf 'cached unrelated package\n' >"$CACHE/other-package@1.0.0/package.json"
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\n# opencode-nexus-cli-shim\n' >"$HOME/.local/bin/nexus"
  printf '#!/bin/sh\n# opencode-nexus-cli-shim\n' >"$HOME/.local/bin/opencode-nexus"

  for _ in 1 2; do
    ( cd "$HOME/project" && "$ROOT/install.sh" ) >/dev/null 2>&1
    sleep 1
  done
  # Exercise cleanup of the legacy generic backup name as well.
  printf 'legacy backup\n' >"$CD/opencode.json.bak.legacy"
  printf 'legacy backup\n' >"$AD/orchestrator.md.bak.legacy"
  printf '%s\n' '---' 'description: OPTIONAL COMPAT AGENT' '---' 'You are the Nexus knowledge-graph agent.' >"$AD/knowledge-graph.md"
  ( cd "$HOME/project" && "$ROOT/uninstall.sh" ) >/dev/null 2>&1

  [[ ! -e "$CD/nexus.models.json" ]] || { echo "nexus.models.json left behind"; exit 1; }
  [[ ! -e "$CD/nexus.models.example.json" ]] \
    || { echo "nexus.models.example.json left behind"; exit 1; }
  [[ ! -e "$CD/nexus-install-manifest.json" ]] || { echo "manifest left behind"; exit 1; }
  [[ ! -e "$CD/plugins/nexus.js" ]] || { echo "local plugin override left behind"; exit 1; }
  grep -q '^ORIGINAL USER ORCHESTRATOR$' "$AD/orchestrator.md" \
    || { echo "pre-existing orchestrator was not restored"; exit 1; }
  [[ ! -e "$AD/knowledge-graph.md" ]] || { echo "legacy Nexus agent left behind"; exit 1; }
  [[ ! -e "$HOME/.local/bin/nexus" && ! -e "$HOME/.local/bin/opencode-nexus" ]] \
    || { echo "CLI shim left behind"; exit 1; }
  [[ ! -e "$CACHE/opencode-nexus@4.3.6" && -e "$CACHE/other-package@1.0.0" ]] \
    || { echo "OpenCode Nexus cache was not removed safely"; exit 1; }
  ! grep -q 'opencode-nexus CLI PATH' "$HOME/.bashrc" \
    || { echo "Nexus PATH block left behind"; exit 1; }
  if find "$CD" -type f \( -name '*.nexus-*' -o -name '*.bak.*' \) -print -quit | grep -q .; then
    echo "Nexus installer backup left behind"; exit 1
  fi
  jq -e '
    .plugin == ["user/plugin"]
    and .agent.orchestrator.model == "user/model"
    and .agent.orchestrator.custom == "keep"
    and .agent.custom.model == "user-model"
    and .permission.other == "keep"
    and .permission.external_directory["custom/path/**"] == "allow"
    and .permission.external_directory["/usr/local/lib/node_modules/@mohammad154/opencode-nexus/**"] == "deny"
    and .permission.skill["user-skill"] == "allow"
    and .permission.skill["nexus-*"] == "ask"
    and ((.agent.orchestrator.permission.skill // {}) | has("nexus-*") | not)
    and ((.agent.custom.permission.skill // {}) | has("nexus-*") | not)
  ' "$CD/opencode.json" >/dev/null
) || fail "full uninstall left Nexus artifacts or changed user configuration"
pass "full uninstall removes models, local plugin, CLI shims, PATH block, cache, permissions, and backups"

# --- Test 3: uninstall without jq still removes agent files ------------------
T2="$(mktemp -d)"
(
  export HOME="$T2"
  CD="$HOME/.config/opencode"; AD="$CD/agents"
  mkdir -p "$AD" "$HOME/bin" "$HOME/project"
  printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/opencode"; chmod +x "$HOME/bin/opencode"
  export PATH="$HOME/bin:/usr/bin:/bin"
  printf '{}\n' >"$CD/opencode.json"
  git init -q "$HOME/project"
  ( cd "$HOME/project" && "$ROOT/install.sh" ) >/dev/null 2>&1
  test -f "$AD/orchestrator.md" || { echo "install did not create agent"; exit 1; }

  # Build a jq-less PATH.
  NOJQ="$T2/nojqbin"; mkdir -p "$NOJQ"
  for c in bash cp mv rm ls mktemp dirname cat date find sed grep chmod head printf; do
    src="$(command -v "$c" || true)"; [[ -n "$src" ]] && ln -sf "$src" "$NOJQ/$c"
  done
  export PATH="$NOJQ"
  command -v jq >/dev/null 2>&1 && { echo "jq unexpectedly still on PATH"; exit 1; }
  ( cd "$HOME/project" && "$ROOT/uninstall.sh" ) >"$T2/uninstall.log" 2>&1
  grep -q "Uninstall complete" "$T2/uninstall.log" || { echo "no complete message"; exit 1; }
  for ag in orchestrator implementer reviewer; do
    [[ ! -f "$AD/$ag.md" ]] || { echo "agent file left behind: $ag"; exit 1; }
  done
) || fail "jq-less uninstall did not remove agent files"
pass "jq-less uninstall still removes agent files"

# --- Test 4: missing pristine backup preserves current user modifications ----
T4="$(mktemp -d)"
(
  export HOME="$T4"
  CD="$HOME/.config/opencode"; AD="$CD/agents"
  mkdir -p "$AD" "$HOME/bin" "$HOME/project"
  printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/opencode"; chmod +x "$HOME/bin/opencode"
  export PATH="$HOME/bin:/usr/bin:/bin"
  printf '{}\n' >"$CD/opencode.json"
  git init -q "$HOME/project"
  printf 'ORIGINAL USER orchestrator\n' >"$AD/orchestrator.md"
  ( cd "$HOME/project" && "$ROOT/install.sh" ) >/dev/null 2>&1

  backup="$(jq -r --arg t "$AD/orchestrator.md" '.files[$t].original_backup' "$CD/nexus-install-manifest.json")"
  [[ -n "$backup" && -f "$backup" ]] || { echo "install did not create pristine backup"; exit 1; }
  rm -f "$backup"
  printf 'CURRENT USER MODIFICATION\n' >"$AD/orchestrator.md"

  ( cd "$HOME/project" && "$ROOT/uninstall.sh" ) >"$T4/uninstall.log" 2>&1
  grep -q "original backup missing or unusable" "$T4/uninstall.log" \
    || { echo "missing-backup warning not emitted"; cat "$T4/uninstall.log"; exit 1; }
  grep -q '^CURRENT USER MODIFICATION$' "$AD/orchestrator.md" \
    || { echo "current user modification was deleted"; exit 1; }
)
pass "missing pristine backup preserves current user modification"

# --- Test 5: post-install skill rules and a string shorthand survive ----------
T5="$(mktemp -d)"
(
  export HOME="$T5"
  CD="$HOME/.config/opencode"
  mkdir -p "$CD" "$HOME/bin" "$HOME/project"
  printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/opencode"; chmod +x "$HOME/bin/opencode"
  export PATH="$HOME/bin:/usr/bin:/bin"
  git init -q "$HOME/project"
  printf '{ "permission": { "skill": "allow", "other": "keep" } }\n' >"$CD/opencode.json"
  ( cd "$HOME/project" && "$ROOT/install.sh" ) >/dev/null 2>&1
  jq -e '
    .permission.other == "keep"
    and .permission.skill["*"] == "allow"
    and .permission.skill["nexus-*"] == "deny"
    and (.permission.skill | keys_unsorted[0]) == "*"
  ' "$CD/opencode.json" >/dev/null
  tmp="$(mktemp)"
  jq '.permission.skill["added-later"] = "ask"' "$CD/opencode.json" >"$tmp"
  mv "$tmp" "$CD/opencode.json"
  ( cd "$HOME/project" && "$ROOT/uninstall.sh" ) >/dev/null 2>&1
  jq -e '
    .permission.other == "keep"
    and .permission.skill["*"] == "allow"
    and .permission.skill["added-later"] == "ask"
    and (.permission.skill | has("nexus-*") | not)
  ' "$CD/opencode.json" >/dev/null
) || fail "uninstall did not preserve unrelated skill rules"
pass "uninstall preserves post-install skill rules and drops only Nexus keys"

T6="$(mktemp -d)"
(
  export HOME="$T6"
  CD="$HOME/.config/opencode"
  mkdir -p "$CD" "$HOME/bin" "$HOME/project"
  printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/opencode"; chmod +x "$HOME/bin/opencode"
  export PATH="$HOME/bin:/usr/bin:/bin"
  git init -q "$HOME/project"
  printf '{ "permission": { "skill": "allow" } }\n' >"$CD/opencode.json"
  ( cd "$HOME/project" && "$ROOT/install.sh" ) >/dev/null 2>&1
  ( cd "$HOME/project" && "$ROOT/uninstall.sh" ) >/dev/null 2>&1
  jq -e '.permission.skill == "allow"' "$CD/opencode.json" >/dev/null
) || fail "uninstall did not restore a pre-existing skill permission shorthand"
pass "uninstall restores a pre-existing skill permission shorthand"

T7="$(mktemp -d)"
(
  export HOME="$T7"
  CD="$HOME/.config/opencode"
  mkdir -p "$CD" "$HOME/bin" "$HOME/project"
  printf '#!/bin/sh\nexit 0\n' >"$HOME/bin/opencode"; chmod +x "$HOME/bin/opencode"
  export PATH="$HOME/bin:/usr/bin:/bin"
  git init -q "$HOME/project"
  printf '%s\n' '{
    "permission": { "skill": "ask" },
    "agent": { "implementer": { "permission": { "skill": "deny" }, "custom": "keep" } }
  }' >"$CD/opencode.json"
  ( cd "$HOME/project" && "$ROOT/install.sh" ) >/dev/null 2>&1
  jq -e '
    .permission.skill["*"] == "ask"
    and .permission.skill["nexus-*"] == "deny"
    and .agent.implementer.permission.skill["*"] == "deny"
    and .agent.implementer.permission.skill["nexus-impact-analysis"] == "allow"
    and .agent.implementer.custom == "keep"
  ' "$CD/opencode.json" >/dev/null
  ( cd "$HOME/project" && "$ROOT/uninstall.sh" ) >/dev/null 2>&1
  jq -e '
    .permission.skill == "ask"
    and .agent.implementer.permission.skill == "deny"
    and .agent.implementer.custom == "keep"
  ' "$CD/opencode.json" >/dev/null
) || fail "uninstall did not restore ask and implementer skill shorthands"
pass "uninstall restores ask and the implementer skill shorthand"

echo "PASS: uninstall lifecycle regressions"
