# Nexus Outcome Memory

## 2026-07-30 - V3 gate-integrity (PR A)

- Handoffs must be schema 1.1 with envelope bindings; legacy 1.0/0.9 become `legacy_unverified` and cannot complete gates.
- Graph/blast `trusted` labels are non-authoritative without provider revalidation and sealed digests; only `classify --apply` may authorize direct.
- Implementer `base_commit`/`commit` and reviewer `reviewed_commit` bindings are role-specific; do not bind reviewers to pre-implementation `head_commit`.
- Direct mode remains existing-diff-only until PR B two-stage worktree authorization.

## 2026-07-30 - trustworthy workflow hardening

- Direct execution now requires authoritative non-clean Git diff evidence, a fresh trusted PRECISE graph, and a fresh trusted LOW blast report. Conservative, stale, missing, or heuristic analysis requires delegation or explicit verification.
- Graph extraction records content hashes and freshness metadata; comment-aware fallback extraction avoids treating examples and comments as dependencies while remaining conservative when parser precision is unavailable.
- Provider modes, call budgets, telemetry, trajectories, and the OpenCode installer now expose their actual capabilities instead of implying unsupported precision or pricing.
