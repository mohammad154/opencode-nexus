#!/usr/bin/env bash
# Guarded branch cleanup — deterministic replacement for LLM implementer cleanup.
# Usage:
#   bash scripts/nexus-branch-cleanup.sh --base <base_branch> <branch> [branch...]
#   bash scripts/nexus-branch-cleanup.sh --base main --json .opencode/CONTEXT.md   # not parsed; pass branches explicitly
#
# Safety:
#   - Refuses to delete base_branch, main, master, develop, HEAD
#   - Requires branch tip to be ancestor of base (merged) unless --force-discard
#   - Never uses git branch -D unless --force-discard
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
BASE=""
FORCE_DISCARD=0
BRANCHES=()
OUT_JSON=""

usage() {
  echo "Usage: $0 --base <base_branch> [--force-discard] [--out <handoff.json>] <branch> [branch...]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --force-discard) FORCE_DISCARD=1; shift ;;
    --out) OUT_JSON="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) BRANCHES+=("$1"); shift ;;
  esac
done

[[ -n "$BASE" ]] || usage
[[ ${#BRANCHES[@]} -gt 0 ]] || usage

cd "$ROOT"

PROTECTED=("main" "master" "develop" "$BASE" "HEAD")
is_protected() {
  local b="$1" p
  for p in "${PROTECTED[@]}"; do
    [[ "$b" == "$p" ]] && return 0
  done
  return 1
}

DELETED=()
SKIPPED=()
FAILED=()

CURRENT="$(git branch --show-current 2>/dev/null || true)"
# Ensure we are not on a branch we are about to delete
NEED_CHECKOUT=0
for b in "${BRANCHES[@]}"; do
  [[ "$CURRENT" == "$b" ]] && NEED_CHECKOUT=1
done
if [[ "$NEED_CHECKOUT" -eq 1 ]]; then
  git checkout "$BASE"
fi

for b in "${BRANCHES[@]}"; do
  if is_protected "$b"; then
    SKIPPED+=("$b:protected")
    continue
  fi
  if ! git show-ref --verify --quiet "refs/heads/$b"; then
    SKIPPED+=("$b:missing")
    continue
  fi
  if [[ "$FORCE_DISCARD" -eq 0 ]]; then
    if ! git merge-base --is-ancestor "$b" "$BASE" 2>/dev/null; then
      FAILED+=("$b:not-ancestor-of-$BASE")
      continue
    fi
    if git branch -d "$b" 2>/dev/null; then
      DELETED+=("$b")
    else
      FAILED+=("$b:delete-failed")
    fi
  else
    if git branch -D "$b" 2>/dev/null; then
      DELETED+=("$b")
    else
      FAILED+=("$b:force-delete-failed")
    fi
  fi
done

STATUS="DONE"
[[ ${#FAILED[@]} -gt 0 ]] && STATUS="DONE_WITH_CONCERNS"
[[ ${#DELETED[@]} -eq 0 && ${#FAILED[@]} -gt 0 ]] && STATUS="BLOCKED"

echo "[nexus-branch-cleanup] status=$STATUS deleted=${#DELETED[@]} skipped=${#SKIPPED[@]} failed=${#FAILED[@]}"
[[ ${#DELETED[@]} -gt 0 ]] && printf '  deleted: %s\n' "${DELETED[*]}"
[[ ${#SKIPPED[@]} -gt 0 ]] && printf '  skipped: %s\n' "${SKIPPED[*]}"
[[ ${#FAILED[@]} -gt 0 ]] && printf '  failed: %s\n' "${FAILED[*]}"

if [[ -n "$OUT_JSON" ]]; then
  mkdir -p "$(dirname "$OUT_JSON")"
  json_arr() {
    if [[ $# -eq 0 || ( $# -eq 1 && -z "${1:-}" ) ]]; then
      echo "[]"
      return
    fi
    local out="[" first=1 x
    for x in "$@"; do
      [[ -z "$x" && $first -eq 1 && $# -eq 1 ]] && continue
      x="${x//\\/\\\\}"
      x="${x//\"/\\\"}"
      if [[ $first -eq 1 ]]; then first=0; else out+=","; fi
      out+="\"$x\""
    done
    [[ "$first" -eq 1 ]] && { echo "[]"; return; }
    echo "${out}]"
  }
  DEL_JSON=$(json_arr ${DELETED[@]+"${DELETED[@]}"})
  SKIP_JSON=$(json_arr ${SKIPPED[@]+"${SKIPPED[@]}"})
  FAIL_JSON=$(json_arr ${FAILED[@]+"${FAILED[@]}"})
  # Prefer length-based empties
  [[ ${#DELETED[@]} -eq 0 ]] && DEL_JSON="[]"
  [[ ${#SKIPPED[@]} -eq 0 ]] && SKIP_JSON="[]"
  [[ ${#FAILED[@]} -eq 0 ]] && FAIL_JSON="[]"
  if [[ ${#DELETED[@]} -gt 0 ]]; then DEL_JSON=$(json_arr "${DELETED[@]}"); fi
  if [[ ${#SKIPPED[@]} -gt 0 ]]; then SKIP_JSON=$(json_arr "${SKIPPED[@]}"); fi
  if [[ ${#FAILED[@]} -gt 0 ]]; then FAIL_JSON=$(json_arr "${FAILED[@]}"); fi
  cat >"$OUT_JSON" <<EOF
{
  "agent": "nexus-branch-cleanup-script",
  "status": "$STATUS",
  "base_branch": "$BASE",
  "deleted": $DEL_JSON,
  "skipped": $SKIP_JSON,
  "failed": $FAIL_JSON,
  "notes": "Deterministic cleanup; no LLM dispatch"
}
EOF
  echo "  wrote $OUT_JSON"
fi

[[ "$STATUS" != "BLOCKED" ]]
