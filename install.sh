#!/usr/bin/env bash
# OpenCode Nexus installer — V5 fixed three-agent pipeline for OpenCode
# Usage: ./install.sh [--prune-optional-agents] [--uninstall] [-h]
# Deps: bash, jq; git optional.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WITH_OPTIONAL_AGENTS=0
PRUNE_OPTIONAL_AGENTS=1
# Canonical roster (V5).
CANONICAL_AGENTS=(orchestrator implementer reviewer)
OPTIONAL_AGENTS=()
RETIRED_AGENTS=(diagnostician unified-reviewer spec-reviewer code-reviewer integration-reviewer reconciler blast-analyzer)
if [[ "${NEXUS_OPTIONAL_AGENTS:-}" == "1" ]]; then WITH_OPTIONAL_AGENTS=0; fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-optional-agents) WITH_OPTIONAL_AGENTS=1; shift ;;
    --prune-optional-agents) PRUNE_OPTIONAL_AGENTS=1; shift ;;
    --uninstall) exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/uninstall.sh" "${@:2}" ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./install.sh [--prune-optional-agents]
  --prune-optional-agents remove retired V4 agents from the OpenCode install dir
  --uninstall             delegate to uninstall.sh

Canonical agents (V5): orchestrator implementer reviewer
USAGE
      exit 0 ;;
    *)
      echo "Error: unknown argument: $1 (use --help)" >&2
      exit 1
      ;;
  esac
done

nexus_agent_basenames() {
  local a
  for a in "${CANONICAL_AGENTS[@]}"; do echo "$a"; done
}

prune_optional_from_dir() {
  local dest=$1 a
  [[ -d "$dest" ]] || return 0
  for a in "${RETIRED_AGENTS[@]}"; do
    rm -f "$dest/${a}.md" 2>/dev/null || true
  done
}

bak() { [[ -f "$1" ]] && cp "$1" "$1.bak.$(date +%Y%m%d%H%M%S)" || true; }

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
AGENTS_DIR="$CONFIG_DIR/agents"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
MODELS_FILE="$CONFIG_DIR/nexus.models.json"
MANIFEST_FILE="$CONFIG_DIR/nexus-install-manifest.json"
DEFAULT_MODELS="$SCRIPT_DIR/config/default-models.json"
OPTIONAL_MODELS="$SCRIPT_DIR/config/optional-models.json"
MODELS_EXAMPLE="$SCRIPT_DIR/config/models.example.json"
PKG_JSON="$SCRIPT_DIR/package.json"
LEGACY_GIT_SPEC="nexus@git+https://github.com/mohammad154/opencode-nexus.git"

# Record, exactly once per file, whether an agent file existed before Nexus and
# where its pristine pre-Nexus backup lives. Re-running or upgrading Nexus must
# NEVER overwrite the recorded original with a newer Nexus-authored file, so
# uninstall can always restore the user's real original.
manifest_record_original() {
  local target=$1
  command -v jq >/dev/null 2>&1 || return 0
  [[ -f "$MANIFEST_FILE" ]] || printf '{\n  "schema_version": "1.0",\n  "files": {}\n}\n' >"$MANIFEST_FILE"
  # Already recorded → keep the first-seen provenance, do not touch it.
  if jq -e --arg t "$target" '.files[$t] != null' "$MANIFEST_FILE" >/dev/null 2>&1; then
    return 0
  fi
  local existed="false" backup=""
  if [[ -f "$target" ]]; then
    existed="true"
    backup="$target.nexus-original.$(date +%Y%m%d%H%M%S)"
    cp "$target" "$backup"
  fi
  local tmp; tmp="$(mktemp)"
  if jq --arg t "$target" --arg e "$existed" --arg b "$backup" \
    '.files[$t] = {pre_nexus_existed: ($e == "true"), original_backup: (if $b == "" then null else $b end), recorded_at: (now | todate)}' \
    "$MANIFEST_FILE" >"$tmp"; then
    mv "$tmp" "$MANIFEST_FILE"
  else
    rm -f "$tmp"
  fi
}

if command -v jq >/dev/null 2>&1 && [[ -f "$PKG_JSON" ]]; then
  echo "Installing OpenCode Nexus $(jq -r '.version' "$PKG_JSON")..."; echo ""
else
  echo "Installing OpenCode Nexus..."; echo ""
fi

if command -v opencode >/dev/null 2>&1; then
  echo "OpenCode: detected"
else
  echo "OpenCode: not detected (installing config and agents anyway)"
fi
echo ""

echo "[opencode] Installing..."
if ! command -v jq >/dev/null 2>&1; then
  echo "  Error: jq required for OpenCode configuration merging (install jq, then rerun this installer)." >&2
  exit 1
fi
PKG_NAME="$(jq -r '.name' "$PKG_JSON")"
PKG_VERSION="$(jq -r '.version' "$PKG_JSON")"
PLUGIN_SPEC="${NEXUS_PLUGIN_SPEC:-${PKG_NAME}@${PKG_VERSION}}"

mkdir -p "$CONFIG_DIR" "$AGENTS_DIR"
if [[ -f "$CONFIG_FILE" ]]; then bak "$CONFIG_FILE"; else printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' >"$CONFIG_FILE"; fi
MJ="$(cat "$DEFAULT_MODELS")"
if (( WITH_OPTIONAL_AGENTS )) && [[ -f "$OPTIONAL_MODELS" ]]; then
  MJ="$(jq -s '.[0] * .[1]' "$DEFAULT_MODELS" "$OPTIONAL_MODELS")"
fi
if [[ -f "$MODELS_FILE" ]]; then
  MJ="$(jq -s 'def strip: with_entries(select(.key|startswith("_")|not)); .[0]*(.[1]|strip)' <(printf '%s\n' "$MJ") "$MODELS_FILE")"
else
  cp "$MODELS_EXAMPLE" "$CONFIG_DIR/nexus.models.example.json"
  echo "  Created $CONFIG_DIR/nexus.models.example.json"
fi
OPTIONAL_JSON="$(printf '%s\n' "${OPTIONAL_AGENTS[@]}" | jq -R . | jq -s .)"
RETIRED_JSON="$(printf '%s\n' "${RETIRED_AGENTS[@]}" | jq -R . | jq -s .)"
# Always strip underscore meta-keys and nested _comment so jq agent merge stays object+object
MJ="$(jq 'def strip: with_entries(select(.key|startswith("_")|not));
  strip | with_entries(.value = (if (.value|type)=="object" then (.value|strip) else .value end))' <<<"$MJ")"
for spec in "orchestrator:NEXUS_ORCHESTRATOR_MODEL" "implementer:NEXUS_IMPLEMENTER_MODEL" "reviewer:NEXUS_REVIEWER_MODEL"; do
  IFS=: read -r ag envv <<<"$spec"; v="${!envv:-}"; [[ -n "$v" ]] && MJ="$(jq --arg a "$ag" --arg m "$v" '.[$a].model=$m' <<<"$MJ")"
done
for spec in "implementer:NEXUS_IMPLEMENTER_VARIANT:NEXUS_IMPLEMENTER_REASONING_EFFORT" "reviewer:NEXUS_REVIEWER_VARIANT:NEXUS_REVIEWER_REASONING_EFFORT"; do
  IFS=: read -r ag envv legacy_envv <<<"$spec"; v="${!envv:-${!legacy_envv:-}}"; [[ -n "$v" ]] && MJ="$(jq --arg a "$ag" --arg e "$v" '.[$a].variant=$e' <<<"$MJ")"
done
# Drop retired V4 agents from the merge payload
MJ="$(jq --argjson skip "$RETIRED_JSON" 'reduce $skip[] as $k (.; del(.[$k]))' <<<"$MJ")"
# Always prune retired V4 agent config keys from existing opencode.json on upgrade.
# OpenCode treats agent keys in opencode.json as selectable agents; without
# mode:subagent they show up in the primary "Select agent" menu — so retired
# keys must never linger, and canonical modes must be forced every install.
PRUNE_JSON="$RETIRED_JSON"
TMP="$(mktemp)"
# Keep object context: `.plugin=(...)` would pipe the array and break later merges
# Only merge object-valued agent entries (skip any leftover non-objects)
if ! jq --arg p "$PLUGIN_SPEC" --arg name "$PKG_NAME" --arg legacy "$LEGACY_GIT_SPEC" --argjson m "$MJ" --argjson prune "$PRUNE_JSON" '
  .plugin = (
    ((.plugin // []) | map(select(
      . != $legacy
      and . != $name
      and (startswith($name + "@") | not)
    ))) + [$p]
  )
  | .agent = (.agent // {})
  | reduce (($m | to_entries[] | select(.value|type=="object")) ) as $e (.;
      .agent[$e.key] = ((.agent[$e.key] // {}) + $e.value))
  | reduce $prune[] as $k (.;
      if .agent[$k] then
        .agent |= del(.[$k])
      else . end)
  | if .agent.orchestrator then .agent.orchestrator.mode = "primary" else . end
  | if .agent.implementer then .agent.implementer.mode = "subagent" else . end
  | if .agent.reviewer then .agent.reviewer.mode = "subagent" else . end
  | .permission = (.permission // {})
  | .permission.external_directory = (
      (.permission.external_directory // {})
      + {
          "/usr/local/lib/node_modules/@mohammad154/opencode-nexus/**": "allow",
          "/usr/local/lib/node_modules/@mohammad154/opencode-nexus/schemas/*": "allow",
          "~/.cache/opencode/packages/@mohammad154/**": "allow"
        }
    )
' "$CONFIG_FILE" >"$TMP"; then
  echo "  Error: failed to merge plugin/models into $CONFIG_FILE"
  rm -f "$TMP"
  exit 1
fi
mv "$TMP" "$CONFIG_FILE"
while IFS= read -r ag; do
  src="$SCRIPT_DIR/agents/$ag.md"; [[ -f "$src" ]] || continue
  # Record the pristine pre-Nexus original exactly once, then install.
  manifest_record_original "$AGENTS_DIR/$ag.md"
  bak "$AGENTS_DIR/$ag.md"; cp "$src" "$AGENTS_DIR/$ag.md"
done < <(nexus_agent_basenames)
prune_optional_from_dir "$AGENTS_DIR"
echo "  [opencode] V5 agents: orchestrator, implementer, reviewer"
echo "  [opencode] Done → $CONFIG_FILE agents: $AGENTS_DIR/"

echo ""; echo "[scripts] Checking:"
for s in nexus-impact.js nexus-blast.sh nexus-blast.js nexus-branch-cleanup.sh nexus-estimate-calls.js nexus-run.js nexus-classify.js; do if [[ -f "$SCRIPT_DIR/scripts/$s" ]]; then echo "  ✓ scripts/$s"; else echo "  ✗ missing $s"; fi; done
chmod +x "$SCRIPT_DIR/scripts/nexus-blast.sh" "$SCRIPT_DIR/scripts/nexus-branch-cleanup.sh" 2>/dev/null || true
chmod a+r "$SCRIPT_DIR/scripts/nexus-blast.js" "$SCRIPT_DIR/scripts/nexus-estimate-calls.js" "$SCRIPT_DIR/scripts/nexus-run.js" "$SCRIPT_DIR/scripts/nexus-classify.js" 2>/dev/null || true

cat <<END

Installation complete (Nexus V5 — fixed pipeline: brainstorm → plan → impact → implement → review).
Canonical agents: orchestrator, implementer, reviewer.
Impact Engine is the default evidence provider.
OpenCode → ~/.config/opencode/ (plugin + canonical agents)
Next:
  - nexus project-init
  - nexus run init --run-id demo
  - nexus estimate --tasks 3
  - nexus impact --json --targets <path>
  - bash ./scripts/nexus-branch-cleanup.sh --base <base> <feature-branch>
  - restart OpenCode and select orchestrator
  - Customize: edit $CONFIG_DIR/nexus.models.json && re-run install
Uninstall:
  nexus uninstall
  ./uninstall.sh
END
