# Impact Analysis

Use the Nexus Impact Engine instead of Graphify/blast.

```bash
nexus impact --json
# or
node scripts/nexus-impact.js --json --base HEAD
```

Evidence includes git diff, changed symbols, imports/dependents, related tests, **risk**, and **confidence** (separate fields).

Low confidence (&lt; 0.75) escalates verification and review. Never invent impact numbers in agent prose — scripts measure.
