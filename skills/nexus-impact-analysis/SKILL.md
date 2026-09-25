---
name: nexus-impact-analysis
description: Use when reading or sealing a Nexus impact report — pre-impact before every implementer dispatch and post-impact during verification. Scripts measure risk, confidence, callers, and tests; never invent those numbers.
compatibility: opencode
---

# Impact Analysis (V5)

Use the Nexus Impact Engine (deterministic scripts — not an agent).

```bash
nexus impact --json
# or
node scripts/nexus-impact.js --json --base HEAD --targets <files>
```

## When

- **Pre-impact** — before **every** implementer dispatch (first attempt and every REQUEST_CHANGES fix).
- **Post-impact** — run by `nexus verify` while the durable run is in VERIFYING after implementation (detects scope expansion vs plan).

Evidence includes git diff, changed symbols, imports/dependents, related tests, **risk**, and **confidence** (separate fields).

Never invent impact numbers in agent prose — scripts measure.

Invariant: **no implementer without fresh sealed pre-impact for the current unit.**
