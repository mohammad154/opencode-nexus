# OpenCode Nexus — V3 Compatibility (Historical)

This document describes the **legacy V3** mental model. Nexus V5 uses the **Nexus Impact Engine** only.

## What changed in V4+

| V3 (legacy) | V4+ (canonical) |
| --- | --- |
| External graph → blast → implement | Nexus Impact Engine → implement → post-impact |
| Graph tooling required for trusted analysis | Built-in impact analysis (`nexus impact`) |
| Blast terminology in prompts | Impact reports; `blast` CLI kept as compatibility alias |

## V5 status

Graphify integration has been **removed from Nexus**. Do not install or reference Graphify for Nexus workflows.

New runs should:

1. Use Nexus Impact Engine evidence (`nexus impact --json`)
2. Keep agent instructions on impact-first orchestration language
3. Store outcome memory under `.opencode/memory/` and `.opencode/reflections/`

See the main [README](../README.md) for the current workflow.
