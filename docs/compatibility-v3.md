# OpenCode Nexus — V3 / Graphify Compatibility

This document is the only place that describes the **legacy V3 Graphify-driven** mental model.
Normal README, agent prompts, and skills describe **V4+ Nexus Impact Engine** only.

## What changed in V4+

| V3 (legacy) | V4+ (canonical) |
| --- | --- |
| Graphify graph → blast → implement | Nexus Impact Engine → implement → post-impact |
| Graphify required for trusted analysis | Graphify optional (visualization / inspection) |
| Blast terminology in prompts | Impact reports; `blast` fields kept as legacy mirrors |

## When Graphify still appears

- Optional `graphify` on `PATH` for repository visualization
- Legacy Graphify blast provider paths under `scripts/lib/providers.js` (compatibility)
- `compatibility_mode: "v3"` run flags (e.g. `legacy_skip_final`) for older workflows

Trusted Graphify blast reports must bind to the current git HEAD: missing report HEAD is **not** trusted.

## Do not use for new work

New runs should:

1. Prefer Nexus Impact Engine evidence
2. Treat Graphify as optional tooling, never as required runtime evidence
3. Keep agent instructions free of V3 “blast-first” orchestration language

See the main [README](../README.md) for the current workflow.
