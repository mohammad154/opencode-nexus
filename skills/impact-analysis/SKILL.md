# Impact Analysis (V5)

Use the Nexus Impact Engine (deterministic scripts — not an agent).

```bash
nexus impact --json
# or
node scripts/nexus-impact.js --json --base HEAD --targets <files>
```

## When

- **Pre-impact** — before **every** implementer dispatch (first attempt and every REQUEST_CHANGES fix).
- **Post-impact** — during VERIFYING after implementation (detects scope expansion vs plan).

Evidence includes git diff, changed symbols, imports/dependents, related tests, **risk**, and **confidence** (separate fields).

Never invent impact numbers in agent prose — scripts measure.

Invariant: **no implementer without fresh sealed pre-impact for the current unit.**
