# Nexus troubleshooting

## Impact includes a runtime or generated file

1. Check the report's `ignored_files` and `path_filter.ignored_patterns`.
2. Confirm the path is relative to the worktree and matches the intended
   pattern, for example `.venv/**`, `__pycache__/**`, `*.pyc`, `.cache/**`,
   `dist/**`, or `.antigravity/**`.
3. Re-run `nexus impact --json`. A path-filter or parser-version mismatch
   invalidates the impact cache automatically.
4. If necessary, inspect `.opencode/cache/impact/meta.json`; it must contain
   the current cache, parser, and path-filter versions.

Never delete a cache to hide an unexpected result. Rebuild it and inspect the
reported invalidation reason.

## PLANNED is blocked by the plan-advisor decision

Two distinct errors come from the deterministic planning decision.

`plan-advisor is required before PLANNED (<reason codes>)` means a hard safety
signal, deep planning, declared uncertainty, or insufficient evidence made an
independent challenge mandatory. The reason codes name what triggered it. Either
dispatch `plan-advisor` once and pass its handoff, or change the evidence if the
classification was wrong — do not fabricate an advisor handoff.

`compact planning is not admissible for this change: <signals>` means the run
declared `planning_mode: compact` while a deterministic signal (for example
`SECURITY_BOUNDARY`) disqualifies compact planning. Raise the depth to `standard`
or `deep`; compact cannot be used to avoid the challenge.

If the decision is stricter than you expect, inspect the persisted record:

```bash
nexus run inspect --run-id <id>   # plan_advisor_decision.reason_codes
```

`INSUFFICIENT_PLANNING_EVIDENCE` is not a bug: with no cohesion or pattern
evidence Nexus cannot prove the challenge is unnecessary, so it reserves the
call. Report `unit_count`, `cohesive_unit`, `known_pattern`, and `risk` to get the
zero-advisor path.

## VERIFYING is blocked by a handoff

Look for `implementer handoff invalid` in the transition errors. Common causes
are missing `files_changed`, `tests`, `development_checks` (or the legacy
`verification_gates` alias), `drift_check`, or
`impact.verified`/`blast.verified`. Also check that:

- `status` is `DONE` or `DONE_WITH_CONCERNS`;
- at least one implementation check is reported and every reported check has
  `pass: true`;
- object-form `tests.passed` is `true`;
- `base_commit`, `commit`, `run_id`, and `unit_or_task` bind to the run; and
- `drift_check.pass` is `true`.

`development_checks` records the checks the implementer ran for development
feedback. It is not authoritative verification: the implementer is not expected
to pre-run the full test suite, repository lint, whole-project typecheck, or
build. `nexus verify` owns those and must return `PASSED` before a reviewer is
dispatched.

The preflight gate runs before post-impact and test providers. Fix the handoff
or explicitly block the run. After the fast transition succeeds, run
`nexus verify`; do not attempt to attach provider-shaped evidence to a later
transition.

## Verification times out or is interrupted

The run remains in `VERIFYING` (or `FINAL_VERIFYING`), never returns to
`IMPLEMENTING`. Progress is written after every step in
`.opencode/runs/<run-id>/verification.json` and summarized in `state.json`.

```bash
nexus next                         # should say resume_verification
nexus verify --resume
```

Passed steps are reused only if the verification artifact digest, current
HEAD, plan digest, and timeout/configuration digest all still match. If HEAD
changed, Nexus refuses to verify it under the old handoff; restore the expected
commit or start the normal repair workflow rather than reusing evidence.

Final verification can also reuse a task result, but only when the full evidence
identity is unchanged: HEAD, workspace content digest, argv, timeout
configuration, scope policy, dependency lockfiles, and toolchain. Any difference
re-executes the check. A failed, timed-out, or unavailable result is never
reused. `reused_steps` and `ran_steps` in the sealed artifact show what actually
executed.

Project-level timeout defaults live in `.opencode/config/workflow.json` under
`verificationTimeouts`; environment overrides include
`NEXUS_VERIFY_TIMEOUT_TEST` and `NEXUS_VERIFY_TIMEOUT_BUILD`. A timeout is a
failure state, never a passing check.

## Verification is FAILED

Inspect the durable evidence before changing code:

```bash
nexus run inspect --run-id <id>
nexus next
```

Do not dispatch a reviewer and do not bypass the state gate. Follow `nexus
next`: it automatically enters the guarded impact/implementer repair loop once
when the evidence is eligible; otherwise reconcile the failure manually, then
run a fresh `nexus verify`.

## VERIFYING is blocked by CONTROL_PLANE_TAMPERED

The transition into `VERIFYING` compares the current orchestrator-owned
`.opencode` runtime against the snapshot taken when the run entered
`IMPLEMENTING`. The gate fails when protected paths changed outside the allowed
handoff area.

1. Inspect transition errors and `nexus run inspect --run-id <id>`.
2. Check `git status` and recent edits under `.opencode/runs/`,
   `.opencode/config/`, `.opencode/plans/`, and other protected trees listed in
   [`architecture.md`](architecture.md#runtime-integrity-control-plane-and-policy-snapshots).
3. Confirm the implementer only wrote handoffs (and production code in scope);
   undo accidental edits to run state, config, or plans.
4. If the snapshot is stale after a legitimate controller recovery, reconcile or
   re-enter implementation with a fresh pre-impact cycle instead of forcing the
   transition.

Handoff files under `.opencode/handoffs/` are the deliberate exception.

## Scope expansion is reported

`SCOPE_EXPANSION_REQUIRED` means Git found a changed path outside the persisted
unit `allowed_files`. Runtime paths such as `.opencode/**`, `.antigravity/**`,
and the default cache/build folders are ignored by the global policy, but a
real source edit still needs scope expansion and a fresh impact run. Handoff
claims cannot suppress this gate.

## A targeted verification command is skipped

The Verification Target Resolver skips unsafe, missing, ignored, binary, and
generated targets. The provider records each one as `SKIPPED` in its results
and continues with valid/full checks. This prevents commands such as
`npm test -- .venv/foo.pyc` or `npm test -- dist/bundle.js` from being treated
as meaningful verification.

If every available step is skipped or unavailable, the provider returns
`VERIFICATION_UNAVAILABLE`; this is not a passing verification result.

## Workspace integrity rejects a runtime symlink

Package managers commonly create executable links under
`.opencode/node_modules/.bin`. Nexus accepts those links only when their
existing canonical targets remain inside `.opencode`; external or dangling
runtime links remain blocked. Do not bypass the verification gate or delete
runtime dependencies to manufacture a clean measurement—repair the path or
update Nexus when a valid internal package-manager link is rejected.
