# Nexus workflow architecture

Nexus keeps measurement and authorization in the workflow engine. Agents may
describe work, but the scripts derive changed files, impact, verification, and
scope from the worktree.

## Evidence flow

```text
git evidence
    │
    ├── shared path filter ──> changed files / ignored files
    │                              │
    │                              ├── AST + import index
    │                              ├── related-test discovery
    │                              └── risk / confidence
    │
    ├── pre-impact ──> TASK_IMPACT_READY ──> IMPLEMENTING
    │
    └── post-impact ──> verification target resolver ──> sealed provider evidence
                                                        │
                                                        └── VERIFYING gate
```

## Impact index and cache

`nexus impact` filters paths before walking source files or calculating the
impact report. The default filter ignores Git metadata, dependency folders,
Python environments and bytecode, build/coverage output, temporary/cache
folders, Nexus runtime artifacts, Graphify output, and `.antigravity/**`.

The index cache lives under `.opencode/cache/impact/` and is keyed by file hash
and parser version. `meta.json` also records the impact-cache and path-filter
versions. A missing, corrupt, or mismatched metadata file invalidates the old
cache and the next run rebuilds it. Entries outside the current filtered file
set are pruned.

Reports expose `ignored_files`, `index_stats.cache_invalidated`, and the path
filter version so an operator can distinguish a measured exclusion from a
missing source file.

## Scope boundaries

The project policy is `.opencode/config/scope-policy.json`; project bootstrap
creates it when absent. The shipped defaults describe allowed areas as
`.opencode/**`, `src/**`, `tests/**`, and `plan/**`, while ignored patterns win
over allowed patterns. The per-unit `allowed_files` list remains the authority
for implementer scope. The policy adds global runtime exclusions; it does not
silently widen a unit's allowlist.

Scope checks use Git-derived files whenever a worktree is available. Handoff
`files_changed` is descriptive and cannot authorize an extra file.

## Handoff contract

An implementer handoff is schema `1.1` and must contain:

- `run_id`, `unit_or_task` (or the compatibility input alias `unit`),
  `agent`, `base_commit`, and `created_at`;
- `status`, `commit`, `files_changed`, and `tests`;
- a non-empty `verification_gates` array whose entries have `id` and `pass`;
- `drift_check` with an explicit `pass` value; and
- measured impact evidence: `impact.verified` or the legacy-compatible
  `blast.verified` field.

`tests` may be an array of command records or an object such as
`{"passed": true, "commands": ["npm test"]}`. For a non-exempt run, all
verification gates must pass and an object-form `tests` value must set
`passed: true`.

Nexus validates this contract before entering `VERIFYING`. A malformed handoff
leaves the run in its current state and no post-impact or verification provider
is invoked. The orchestrator may then transition explicitly to `BLOCKED` with
`INVALID_IMPLEMENTER_HANDOFF` after recording a reason.
