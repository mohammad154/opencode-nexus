# Changelog

## Unreleased

### Direct execution for small tasks

`nexus run init` classifies the workspace and stores `fast_path`. Compact-eligible work, a repository with no user history, or a project with no test suite uses direct mode: a five-line session plan, no `PLAN.md`, no plan-advisor, and no feature branch. An unclassified request on a repository with history and tests stays on the standard pipeline. The orchestrator may edit at most 20 lines, or dispatch one implementer in the current directory. The CLI commits that edit before verification. Final verification still runs before COMPLETED. The reviewer runs only after the check fails twice or impact risk is HIGH/CRITICAL. Size, risk, or a safety signal escalates to standard, including mid-run through `nexus run classify --apply`. `NEXUS_FAST_PATH=0`, `--no-triage`, or `workflow.fastPath: false` keeps the standard pipeline.

### Bounded subagent waits

Plan-advisor, reviewer, and implementer calls have wall-clock budgets of 5, 10, and 20 minutes (`budget_ms` on the role in `nexus.models.json`, which the plugin reads, or `NEXUS_*_BUDGET_MS`). The plugin watchdog records a run-scoped `TIMED_OUT` under `.opencode/runs/<run_id>/` and aborts only the child mapped to that call. `nexus next` skips a timed-out advisor, continues to final verification after a timed-out reviewer, and re-dispatches a timed-out implementer once per unit. A timeout cannot skip final verification or mark the run COMPLETED. Reviewer remediation is one round, or two when impact risk is HIGH or CRITICAL. The reviewer agent has a 24-step ceiling. Empty review-round settings are treated as unset.

### Private git baseline

`nexus run init` in a directory that is not already a git work tree creates a private repository, commits the current files as `nexus-baseline` with a repo-local identity, `--no-verify`, and hooks disabled. Heavy directories and files over 5 MB stay out of that commit. The marker is stored under `.opencode/runs/<run_id>/` and removed after a successful cleanup. `.git` is deleted only when this run created it and HEAD is still exactly that one commit, with no other refs or worktrees. `nexus run cleanup` uses the same rule. An existing repository is left untouched, and global git config is never changed. A content-hash snapshot is written only when the `git` binary is missing, and later checks diff the workspace against it. Plan-check uses the baseline commit for the same run instead of failing on `NO_GIT_REPO`.

### Permission patterns match absolute paths

Orchestrator control-plane writes and implementer control-plane denials use both relative and absolute glob patterns, so OpenCode's absolute-path matching allows `.opencode/**` and still denies edits to run state. The orchestrator may run exact read-only probes (`ls`, `cat`, `head`, `wc`, `rg`, `find`, `python3 --version`). Redirects, `find -delete`, `find -exec`, and `git init` / `git add` / `git commit` stay denied; the CLI performs those git writes. Top-level files are ask, and names that merely contain `..` are not treated as traversal. Package `external_directory` rules use `**/@mohammad154/opencode-nexus/**` instead of a hard-coded `/usr/local/lib` prefix, and the plugin denies edits to that installed package. `nexus install` runs a permission self-test and fails if an orchestrator write to its own plan would be denied.
