---
name: nexus-impact-analysis
description: Use when the orchestrator seals a Nexus impact report, or when the implementer or reviewer reads the report that is already sealed. Scripts measure risk, confidence, callers, and tests; never invent those numbers.
compatibility: opencode
---

# Impact Analysis (V5)

The Impact Engine is a deterministic script. Never invent impact numbers in agent prose.

## Orchestrator

Run impact when sealing evidence:

- **Pre-impact** — before every implementer dispatch (first attempt and every REQUEST_CHANGES fix).
- **Post-impact** — `nexus verify` runs this while the durable run is in VERIFYING (detects scope expansion vs plan).

```bash
nexus impact --json
```

Evidence includes git diff, changed symbols, imports/dependents, related tests, **risk**, and **confidence** (separate fields).

## Implementer and reviewer

Read the sealed report that already exists for this unit: risk, confidence, related tests, dependents, and callers. Do not run `nexus impact` again. A second run does not create new evidence.

Invariant: **no implementer without fresh sealed pre-impact for the current unit.** The orchestrator produces that seal; the implementer and reviewer consume it.
