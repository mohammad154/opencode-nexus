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
Removes the OpenCode Nexus integration, CLI helpers, model files, and installer residue.
Preserves unrelated shared config and project-local .opencode/ workflow data.
USAGE
      exit 0 ;;
    *)
      echo "Error: unknown argument: $1 (use --help)" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CD="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
AD="$CD/agents"
CF="$CD/opencode.json"
MODELS_FILE="$CD/nexus.models.json"
MODELS_EXAMPLE_FILE="$CD/nexus.models.example.json"
LOCAL_PLUGIN_FILE="$CD/plugins/nexus.js"
MANIFEST_FILE="$CD/nexus-install-manifest.json"

# These names cover the current V5 roster and every legacy agent that the
# package has installed. Keep this list explicit: arbitrary user agents must
# survive.
NAG='["orchestrator","implementer","reviewer","plan-advisor","diagnostician","unified-reviewer","spec-reviewer","code-reviewer","integration-reviewer","reconciler","blast-analyzer","knowledge-graph"]'
PERMISSION_PATHS='["/usr/local/lib/node_modules/@mohammad154/opencode-nexus/**","/usr/local/lib/node_modules/@mohammad154/opencode-nexus/schemas/*","~/.cache/opencode/packages/@mohammad154/**"]'

cleanup_backups_for_path() {
  local t=$1
  # .bak.* is the legacy backup name used by older Nexus releases. The
  # Nexus-specific name is used by current installs and is unambiguous.
  rm -f "$t".nexus-original.* "$t".nexus-backup.* "$t".bak.* "$t.bak" 2>/dev/null || true
}

manifest_has_entry() {
  local t=$1
  if [[ ! -f "$MANIFEST_FILE" ]]; then
    return 1
  fi
  if command -v jq >/dev/null 2>&1; then
    jq -e --arg t "$t" '.files[$t] != null' "$MANIFEST_FILE" >/dev/null 2>&1
    return $?
  fi
  # The fallback is intentionally narrow and only supports the absolute paths
  # written by this installer. It keeps jq-less cleanup ownership-aware.
  grep -Fq "\"$t\"" "$MANIFEST_FILE"
}

has_backup_for_path() {
  local t=$1
  compgen -G "$t.nexus-original.*" >/dev/null \
    || compgen -G "$t.nexus-backup.*" >/dev/null \
    || compgen -G "$t.bak.*" >/dev/null \
    || [[ -f "$t.bak" ]]
}

is_nexus_agent_file() {
  local t=$1
  [[ -f "$t" ]] || return 1
  grep -Eq 'opencode-nexus|You are the Nexus|OPTIONAL COMPAT AGENT' "$t"
}

restore_owned_file() {
  local t=$1 source="${2:-}"
  if manifest_has_entry "$t" || has_backup_for_path "$t"; then
    bak_restore "$t"
  elif [[ -n "$source" && -f "$t" && -f "$source" ]] \
      && command -v cmp >/dev/null 2>&1 && cmp -s "$source" "$t"; then
    # Compatibility with a first install from a pre-manifest release: an
    # unmodified file that exactly matches the shipped artifact is Nexus-owned.
    rm -f "$t"
  elif is_nexus_agent_file "$t"; then
    # Compatibility with a legacy install that predates provenance manifests.
    # Only remove a file carrying a Nexus-specific marker; arbitrary agents
    # with the same basename remain untouched.
    rm -f "$t"
  fi
}

bak_restore() {
  local t=$1
  # Prefer the pristine pre-Nexus original recorded in the install manifest.
  if [[ -f "$MANIFEST_FILE" ]] && command -v jq >/dev/null 2>&1; then
    local recorded existed backup
    recorded="$(jq -e --arg t "$t" '.files[$t] != null' "$MANIFEST_FILE" 2>/dev/null || true)"
    if [[ "$recorded" == "true" ]]; then
      existed="$(jq -r --arg t "$t" '.files[$t].pre_nexus_existed' "$MANIFEST_FILE" 2>/dev/null || echo "false")"
      backup="$(jq -r --arg t "$t" '.files[$t].original_backup // ""' "$MANIFEST_FILE" 2>/dev/null || echo "")"
      if [[ "$existed" == "true" && -n "$backup" && -f "$backup" ]]; then
        mv "$backup" "$t"
      else
        # File did not exist before Nexus, or its pristine copy is unavailable.
        rm -f "$t"
      fi
      # Drop the manifest entry now that provenance is consumed.
      local tmp; tmp="$(mktemp)"
      if jq --arg t "$t" 'del(.files[$t])' "$MANIFEST_FILE" >"$tmp"; then mv "$tmp" "$MANIFEST_FILE"; else rm -f "$tmp"; fi
      cleanup_backups_for_path "$t"
      return 0
    fi
  fi

  # Fallback for old installs and jq-less cleanup. Current installs leave a
  # sidecar with the pristine content; older releases used .bak.*.
  local original oldest
  original="$(ls -tr "$t".nexus-original.* 2>/dev/null | head -1 || true)"
  if [[ -n "$original" ]]; then
    mv "$original" "$t"
  else
    oldest="$(ls -tr "$t".bak.* 2>/dev/null | head -1 || true)"
    if [[ -n "$oldest" ]]; then mv "$oldest" "$t"; elif [[ -f "$t.bak" ]]; then mv "$t.bak" "$t"; else rm -f "$t"; fi
  fi
  cleanup_backups_for_path "$t"
}

remove_path_snippets() {
  local file tmp
  for file in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bash_profile"; do
    [[ -f "$file" ]] || continue
    grep -q '^# opencode-nexus CLI PATH$' "$file" || continue
    tmp="$(mktemp)"
    if sed '/^# opencode-nexus CLI PATH$/,/^fi$/d' "$file" >"$tmp"; then
      mv "$tmp" "$file"
    else
      rm -f "$tmp"
      echo "  Warn: could not clean Nexus PATH entry from $file" >&2
    fi
  done
}

remove_cli_shims() {
  local candidate target
  for candidate in \
      "$HOME/.local/bin/nexus" "$HOME/.local/bin/nexus.cmd" \
      "$HOME/.local/bin/opencode-nexus" "$HOME/.local/bin/opencode-nexus.cmd"; do
    if [[ -L "$candidate" ]]; then
      target="$(readlink "$candidate" 2>/dev/null || true)"
      if [[ "$target" == *opencode-nexus* && "$target" == *"/bin/nexus.js" ]]; then
        rm -f "$candidate"
      fi
    elif [[ -f "$candidate" ]] && grep -q 'opencode-nexus-cli-shim' "$candidate"; then
      rm -f "$candidate"
    fi
  done
}

remove_local_plugin() {
  # A live symlink at this exact path is the documented local Nexus override.
  # Remove it, including a broken link, so it cannot reactivate Nexus after the
  # npm package has been removed. A regular file is removed only when it bears
  # the Nexus plugin marker.
  if [[ -L "$LOCAL_PLUGIN_FILE" ]]; then
    rm -f "$LOCAL_PLUGIN_FILE"
  elif [[ -f "$LOCAL_PLUGIN_FILE" ]] && grep -Eq 'NEXUS_(ROUTER|DELEGATION_GATE|BOOTSTRAP)' "$LOCAL_PLUGIN_FILE"; then
    rm -f "$LOCAL_PLUGIN_FILE"
  fi
}

clean_opencode_config() {
  local pkg_name pkg_version spec config_original_backup config_preexisted
  local tmp filter
  local -a original_args

  pkg_name="$(jq -r '.name' "$SCRIPT_DIR/package.json")"
  pkg_version="$(jq -r '.version' "$SCRIPT_DIR/package.json")"
  spec="${NEXUS_PLUGIN_SPEC:-${pkg_name}@${pkg_version}}"
  config_original_backup=""
  config_preexisted="unknown"
  if [[ -f "$MANIFEST_FILE" ]]; then
    config_preexisted="$(jq -r --arg t "$CF" '.files[$t].pre_nexus_existed // "unknown"' "$MANIFEST_FILE" 2>/dev/null || printf 'unknown')"
    config_original_backup="$(jq -r --arg t "$CF" '.files[$t].original_backup // ""' "$MANIFEST_FILE" 2>/dev/null || true)"
  fi
  original_args=(--argjson original '[]')
  if [[ -n "$config_original_backup" && -f "$config_original_backup" ]]; then
    original_args=(--slurpfile original "$config_original_backup")
  fi

  filter='
    def original_has_top($key):
      (($original | length) > 0)
      and (($original[0] | type) == "object")
      and (($original[0] | has($key)));
    def original_object($key):
      original_has_top($key)
      and (($original[0][$key] | type) == "object");
    def original_nested_object($parent; $key):
      original_object($parent)
      and (($original[0][$parent][$key]? | type) == "object");
    def nexus_plugin:
      (type == "string")
      and (. == $pl or . == $legacy or . == $name or startswith($name + "@"));
    def strip_agent_fields:
      del(.model, .variant, .reasoningEffort, .mode, .steps, .planning_only);

    if (.plugin? | type) == "array" then
      .plugin |= map(select((nexus_plugin | not)))
    else . end
    | if original_has_top("plugin") then .
      elif (((.plugin? | type) == "array") and ((.plugin | length) == 0)) then del(.plugin)
      else . end

    | if original_object("agent") and ((.agent? | type) == "object") then
        .agent |= (
          (reduce $ns[] as $n (. ; del(.[$n])))
          | (reduce $ns[] as $n (. ;
              if ($original[0].agent | has($n)) then .[$n] = $original[0].agent[$n] else . end))
        )
      elif original_object("agent") then .agent = $original[0].agent
    elif ((.agent? | type) == "object") then
      .agent |= (reduce $ns[] as $n (. ;
          if has($n) then
            if ((.[$n] | type) == "object") then
              .[$n] |= strip_agent_fields
              | if .[$n] == {} then del(.[$n]) else . end
            else del(.[$n])
            end
          else . end))
      else . end
    | if original_has_top("agent") then .
      elif (((.agent? | type) == "object") and ((.agent | length) == 0)) then del(.agent)
      else . end

    | if ((.permission? | type) == "object") then
        .permission |= (
          if ((.external_directory? | type) == "object") then
            .external_directory |= (reduce $permission_paths[] as $p (. ; del(.[$p])))
          else . end)
      else . end
    | if original_nested_object("permission"; "external_directory") then
        .permission = (
          (if ((.permission? | type) == "object") then .permission else {} end)
          | .external_directory = (
              (if ((.external_directory? | type) == "object") then .external_directory else {} end)
              | (reduce $permission_paths[] as $p (. ;
                  if ($original[0].permission.external_directory | has($p))
                  then .[$p] = $original[0].permission.external_directory[$p]
                  else . end)))
        )
      else . end
    | if original_nested_object("permission"; "external_directory") then .
      elif (((.permission? | type) == "object")
        and ((.permission.external_directory? | type) == "object")
        and ((.permission.external_directory | length) == 0)) then
          .permission |= del(.external_directory)
      else . end
    | if original_has_top("permission") then .
      elif (((.permission? | type) == "object") and ((.permission | length) == 0)) then del(.permission)
      else . end
  '

  tmp="$(mktemp)"
  if jq "${original_args[@]}" --arg pl "$spec" --arg name "$pkg_name" \
      --arg legacy "nexus@git+https://github.com/mohammad154/opencode-nexus.git" \
      --argjson ns "$NAG" --argjson permission_paths "$PERMISSION_PATHS" \
      "$filter" "$CF" >"$tmp"; then
    mv "$tmp" "$CF"
  else
    echo "  Failed to clean $CF" >&2
    rm -f "$tmp"
    # Only restore/remove a malformed config when Nexus ownership is proven.
    # An untracked user config must never be deleted just because jq cannot
    # parse it.
    if manifest_has_entry "$CF" || has_backup_for_path "$CF"; then
      bak_restore "$CF"
    else
      echo "  Warn: leaving invalid $CF unchanged; no Nexus ownership record exists" >&2
    fi
    return 0
  fi

  # If Nexus created the config and no user keys remain, remove the file too.
  if [[ "$config_preexisted" == "false" && -f "$CF" ]] \
      && jq -e '((del(."$schema") | length) == 0)' "$CF" >/dev/null 2>&1; then
    rm -f "$CF"
  fi
}

echo ""; echo "[opencode] Removing..."
if ! command -v jq >/dev/null 2>&1; then
  echo "  Warn: jq missing — restoring/removing the recorded config instead of parsing JSON"
  # The manifest sidecar lets a jq-less uninstall restore a pre-Nexus config;
  # a config created by Nexus is removed. This avoids leaving an active plugin.
  if [[ -f "$CF" ]] && (manifest_has_entry "$CF" || has_backup_for_path "$CF"); then
    bak_restore "$CF"
  elif [[ -f "$CF" ]]; then
    echo "  Warn: leaving $CF unchanged; no Nexus ownership record exists" >&2
  fi
else
  clean_opencode_config
fi

# Agent file deletion/restoration ALWAYS runs, regardless of jq availability.
for ag in orchestrator implementer reviewer plan-advisor diagnostician unified-reviewer spec-reviewer code-reviewer integration-reviewer reconciler blast-analyzer knowledge-graph; do
  restore_owned_file "$AD/$ag.md" "$SCRIPT_DIR/agents/$ag.md"
done
rm -f "$MODELS_EXAMPLE_FILE"

# nexus.models.json is a Nexus-only override file. Remove it as part of a full
# uninstall, while shared OpenCode configuration and unrelated files survive.
rm -f "$MODELS_FILE"
remove_local_plugin
remove_path_snippets
remove_cli_shims

remove_opencode_package_cache() {
  local cache_root candidate removed=0 xdg_cache_root
  local -a cache_roots=("$HOME/.cache/opencode/packages/@mohammad154")
  xdg_cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/@mohammad154"
  if [[ "$xdg_cache_root" != "${cache_roots[0]}" ]]; then
    cache_roots+=("$xdg_cache_root")
  fi
  for cache_root in "${cache_roots[@]}"; do
    [[ -d "$cache_root" ]] || continue
    shopt -s nullglob
    local -a cache_candidates=(
      "$cache_root/opencode-nexus"
      "$cache_root"/opencode-nexus@*
    )
    shopt -u nullglob
    for candidate in "${cache_candidates[@]}"; do
      [[ -e "$candidate" || -L "$candidate" ]] || continue
      rm -rf -- "$candidate"
      removed=$((removed + 1))
    done
  done
  if (( removed > 0 )); then
    local noun=entries
    (( removed == 1 )) && noun=entry
    echo "  Removed $removed OpenCode Nexus package cache $noun"
  fi
}

remove_opencode_package_cache

# Remove all known Nexus bookkeeping and backup residue, including files left
# by older releases that used the generic .bak.<timestamp> naming.
cleanup_backups_for_path "$CF"
cleanup_backups_for_path "$MODELS_EXAMPLE_FILE"
for ag in orchestrator implementer reviewer plan-advisor diagnostician unified-reviewer spec-reviewer code-reviewer integration-reviewer reconciler blast-analyzer knowledge-graph; do
  cleanup_backups_for_path "$AD/$ag.md"
done
rm -f "$MANIFEST_FILE"

echo "  [opencode] Done. Removed Nexus models, local plugin override, CLI shims, PATH entries, and installer backups"
echo ""; echo "Uninstall complete."
echo "Notes: project-local .opencode/ workflow data is not touched; shared OpenCode config is preserved"
echo "       Project git post-commit hooks are not auto-removed"
