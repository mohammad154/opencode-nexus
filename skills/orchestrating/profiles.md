# Workflow Profiles (V3)

Profiles control assurance vs speed. Record `workflow_profile` in `.opencode/CONTEXT.md`. Default: **`balanced`**.

Canonical config: `config/workflow-profiles.json` + `config/default-workflow.json`.

## Selecting a profile

Keep the three profiles. Classification is two-stage and scores **semantic risk + uncertainty**, with file/line counts only as weak signals.

```text
Request
   ↓
Git/diff evidence
   ↓
Initial semantic classifier
   ↓
FAST / BALANCED / STRICT  +  review_level
   ↓
Graphify + blast
   ↓
Re-evaluate risk + confidence
   ↓
final execution profile + final review level
```

1. Explicit override wins only when it does not weaken computed policy: `--profile fast|balanced|strict` or `workflow_profile` in CONTEXT.
2. Else run the scoring classifier (do **not** treat legacy nested `fastIf.or` as OR):

```bash
nexus classify --class <change_class> [--docs] [--security] [--public-api] [--focused]
nexus classify --blast .opencode/blast/unit.json
```

   - Emits `profile`, `review_level` (`none|unified|dual`), `execution_mode` (`direct|delegated`), `risk_score`, `confidence`, `evidence_quality` (`trusted|partial|unknown`), `reasons[]`, `direct_eligible`.
   - Hard triggers (security, migration, public_api, credential_handling) → `strict` + dual.
   - Strong signals: exported symbols, high fan-in / Graphify callers, cross-package impact, auth/security, database/storage, config/schema/protocol, concurrency, dependency updates, missing tests.
   - Size (`files changed`, `lines changed`) is secondary and cannot alone force `strict`.
   - `fast` only when score ≤ `fast_max`, tiny-internal/docs evidence, `confidence >= 0.85`, and evidence is not UNKNOWN.
   - `confidence` 0.65–0.85 → `balanced` minimum. `confidence < 0.65` → `strict` / reconcile.
   - UNKNOWN (stale Graphify, incomplete blast, missing diff) never means low risk: FAST is denied.
   - Default otherwise: **`balanced`**.
3. After Graphify + blast, reclassify. HIGH blast always escalates **review** to dual; the execution profile stays `balanced` when batching is still safe, and becomes `strict` when semantic/dependency impact is high (many callers, public entry point, cross-package). Record via `nexus-run.js` / CONTEXT.

Announce: `Using profile: balanced (risk-based review, per-feature branch).`

Direct path: only when `direct_eligible` (max 1 file, ≤30 lines, allowed classes, focused validation, confidence ≥ 0.85, trusted/partial evidence, no hard triggers). UNKNOWN or low confidence → delegated.

## Profile behavior

| Behavior    | fast                              | balanced                         | strict                                  |
| ----------- | --------------------------------- | -------------------------------- | --------------------------------------- |
| Branch      | one per request/feature           | one per feature / execution unit | one per task (`feature/task-N-*`)       |
| Implementer | one per execution unit            | one per execution unit           | one per task                            |
| Graph       | script + cache-by-file-hash      | script + cache-by-file-hash     | script; rebuild when resume / next task |
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
  "blast": ".opencode/blast/auth-refresh.json",
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

## Agent-call estimator

Before starting a multi-task plan, run:

```bash
nexus estimate --tasks N --profile balanced
```

Show the estimated agent calls to the user and the recommended profile.

## Hard rules that still apply under all profiles

- Git repo required.
- Prefer scripts for graph / blast / cleanup / gates — do not dispatch LLM agents for those.
- HIGH blast or security/migration/public-api → dual review even under fast/balanced. HIGH blast does not by itself force the `strict` execution profile.
- Explicit `workflow_profile: strict` never auto-downgrades.
- Orchestrator never implements production code unless CONTEXT has exact `execution_mode: direct`; pasted plans do not authorize self-coding.
