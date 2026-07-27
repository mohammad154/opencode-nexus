---
description: Run Nexus orchestrated workflow (profile → plan → graph → blast → implement → review)
---

Invoke the Nexus workflow for the current request.
1. Load `nexus-using-nexus` (set workflow_profile; default balanced).
2. Cost estimate: `node scripts/nexus-estimate-cost.js --tasks N --profile <p>`.
3. Graph via `scripts/nexus-graph.sh` (commit cache); blast via `scripts/nexus-blast.js`.
4. Persist plan/context/execution units/handoffs under `.opencode/`.
5. Review per profile: unified-reviewer OR spec then code (see dispatch.md).
6. Cleanup via `scripts/nexus-branch-cleanup.sh` (not an LLM).
