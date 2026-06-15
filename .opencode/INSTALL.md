# Installing OpenCode Nexus

## Prerequisites

- OpenCode must already be installed: [https://opencode.ai/docs/installation/](https://opencode.ai/docs/installation/)
- [`jq`](https://jqlang.org/) must be installed (e.g. `sudo apt install jq` on Ubuntu/WSL, `brew install jq` on macOS)

## Global installation (recommended)

Run:

```bash
curl -fsSL https://raw.githubusercontent.com/mohammad154/opencode-nexus/main/install.sh | bash
```

The installer:

- Merges the Nexus plugin entry into `~/.config/opencode/opencode.json`
- Merges agent model settings (defaults + optional `nexus.models.json`)
- Copies Nexus agents to `~/.config/opencode/agents/`
- Backs up any existing Nexus agent files as `*.bak`

## Customize models

Create `~/.config/opencode/nexus.models.json` (see `nexus.models.example.json` after install) and re-run the installer.

## Uninstall

Run:

```bash
curl -fsSL https://raw.githubusercontent.com/mohammad154/opencode-nexus/main/uninstall.sh | bash
```

This removes Nexus plugin and Nexus agents while restoring any local backups.
