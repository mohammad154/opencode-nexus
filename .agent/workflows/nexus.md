---
description: Run Nexus orchestrated workflow (plan → graph → blast → implement → dual review)
---

Invoke the Nexus workflow for the current request.
1. Load `nexus-using-nexus` routing guidance.
2. Ensure knowledge graph via `scripts/nexus-graph.sh` when useful.
3. Blast-before-implement via `scripts/nexus-blast.js`.
4. Persist plan/context/handoffs under `.opencode/`.
5. After implementer: `nexus-spec-reviewer` then `nexus-code-reviewer` (see dispatch.md).
6. Require both APPROVED handoff JSONs before finishing the task.
