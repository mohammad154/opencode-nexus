# Workflow Profiles (V3)

Profiles control assurance vs speed. Record `workflow_profile` in `.opencode/CONTEXT.md`. Default: **`balanced`**.

Canonical config: `config/workflow-profiles.json` + `config/default-workflow.json`.

## Selecting a profile

1. Explicit override wins: user says `--profile fast|balanced|strict` or sets `workflow_profile` in CONTEXT.
2. Else classify from change metadata (see `classificationRules` in workflow-profiles.json):
   - docs-only or tiny internal (≤2 files, ≤50 lines, not public API / security) → `fast`
   - security / migration / public API / HIGH blast → `strict`
   - otherwise → `balanced`
3. If blast later reports HIGH while on `fast`/`balanced`, escalate remaining review to dual-review (`strict` review policy for that unit).

Announce: `Using profile: balanced (risk-based review, per-feature branch).`

## Profile behavior

| Behavior    | fast                              | balanced                         | strict                                  |
| ----------- | --------------------------------- | -------------------------------- | --------------------------------------- |
| Branch      | one per request/feature           | one per feature / execution unit | one per task (`feature/task-N-*`)       |
| Implementer | one per execution unit            | one per execution unit           | one per task                            |
| Graph       | script + cache-by-commit          | script + cache-by-commit         | script; rebuild when resume / next task |
| Blast       | once per execution unit           | once per execution unit          | every task                              |
| Review      | unified or skip (docs)            | risk-based matrix                | always spec then code                   |
| LESSONS     | noteworthy-only                   | noteworthy-only                  | every approved task                     |
| Cleanup     | `scripts/nexus-branch-cleanup.sh` | same                             | same (script, not agent)                |

## Execution units (fast + balanced)

Group related tasks into one unit when:

- Same subsystem / feature
- Shared files
- No human approval required between tasks
- Combined scope stays manageable (default max 5 tasks)

Write `.opencode/tasks/execution-unit-<id>.json`:

```json
{
  "id": "auth-refresh",
  "profile": "balanced",
  "branch": "feature/oauth-refresh",
  "tasks": ["task-1", "task-2", "task-3"],
  "shared_files": ["src/auth/service.ts", "src/auth/middleware.ts"],
  "risk": "medium",
  "change_class": "small-feature-with-tests",
  "review": { "required": ["unified"], "status": "pending" },
  "blast": ".opencode/knowledge/blast/auth-refresh.json",
  "acceptance_criteria": [],
  "verification": []
}
```

Also write a human-readable `.opencode/tasks/execution-unit-<id>.md` summarizing goals.

Dispatch **one implementer** for the whole unit (orchestrator does **not** write production code). Review **once** after the unit (unless matrix requires dual).

## Review policy details

See `reviewMatrix` in `config/workflow-profiles.json`.

- **skip**: no reviewer dispatch; orchestrator still runs verification gates / jq on implementer handoff.
- **unified**: dispatch `unified-reviewer` → `.opencode/handoffs/<id>-unified-reviewer.json` must be APPROVED.
- **required** (dual): `spec-reviewer` then `code-reviewer` (unchanged strict gates).

Never self-review in the orchestrator turn when a reviewer is required.

## Cost estimator

Before starting a multi-task plan, run:

```bash
node scripts/nexus-estimate-cost.js --tasks N --profile balanced
# or
bash scripts/nexus-estimate-cost.sh --tasks N --profile balanced
```

Show the estimate to the user and the recommended profile.

## Hard rules that still apply under all profiles

- Git repo required.
- Prefer scripts for graph / blast / cleanup / gates — do not dispatch LLM agents for those.
- HIGH blast or security/migration/public-api → dual review even under fast/balanced.
- Explicit `workflow_profile: strict` never auto-downgrades.
- Orchestrator never implements production code unless CONTEXT has exact `execution_mode: direct`; pasted plans do not authorize self-coding.
