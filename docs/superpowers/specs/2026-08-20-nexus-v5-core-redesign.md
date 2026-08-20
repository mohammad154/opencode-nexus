# OpenCode Nexus V5 Core Redesign

- **Date:** 2026-08-20
- **Version:** 5.0.0
- **Status:** Implemented

## Summary

Nexus V5 replaces profile/classify/dual-review routing with a fixed three-agent pipeline:

1. Every request: brainstorming → writing-plans
2. Every implementer dispatch: fresh pre-impact (Impact Engine)
3. Every task: independent reviewer APPROVED (auto fix-loop on REQUEST_CHANGES)

Agents: `orchestrator`, `implementer`, `reviewer` only.

See [docs/workflow.md](../../workflow.md) and the repository README.
