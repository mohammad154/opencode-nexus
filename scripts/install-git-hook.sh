#!/usr/bin/env bash
# Install Graphify's native refresh hooks in the current project.
set -euo pipefail

if ! command -v graphify >/dev/null 2>&1; then
  echo "Error: Graphify is required to install the Nexus refresh hook, but 'graphify' was not found." >&2
  echo "Install Graphify with OpenCode, then rerun scripts/install-git-hook.sh." >&2
  exit 1
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "Error: run scripts/install-git-hook.sh inside a Git repository." >&2
  exit 1
fi

cd "$ROOT"
exec graphify hook install

