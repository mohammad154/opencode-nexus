---
description: Obsolete compatibility stub. Do not dispatch — use Nexus Impact Engine (`nexus impact --json`) for deterministic impact analysis.
mode: subagent
permission:
  external_directory:
    "/usr/local/lib/node_modules/@mohammad154/opencode-nexus/**": allow
  edit:
    "*": deny
  bash: allow
  task:
    "*": deny
---

# Blast Analyzer (compatibility stub)

**Obsolete in Nexus V4.** Use the Impact Engine instead:

```bash
nexus impact --json
```

Do not dispatch this agent for deterministic impact work.
