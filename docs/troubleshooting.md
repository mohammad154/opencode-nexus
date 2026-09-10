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

## VERIFYING is blocked by a handoff

Look for `implementer handoff invalid` in the transition errors. Common causes
are missing `files_changed`, `tests`, `verification_gates`, `drift_check`, or
`impact.verified`/`blast.verified`. Also check that:

- `status` is `DONE` or `DONE_WITH_CONCERNS`;
- every `verification_gates[*].pass` is `true`;
- object-form `tests.passed` is `true`;
- `base_commit`, `commit`, `run_id`, and `unit_or_task` bind to the run; and
- `drift_check.pass` is `true`.

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

Do not dispatch a reviewer and do not bypass the state gate. Repair through the
normal impact/implementer loop when code must change, then run a fresh
`nexus verify`.

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
