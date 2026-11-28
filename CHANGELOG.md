# Changelog

## Unreleased

### Direct execution for small tasks

`nexus run init` classifies the workspace and stores `fast_path`. Compact-eligible work, an unclassified request, a repository with no user history, or a project with no test suite uses direct mode: a five-line session plan, no `PLAN.md`, no plan-advisor, and no feature branch. The orchestrator may edit at most 20 lines, or dispatch one implementer in the current directory. The reviewer runs only after the check fails twice or impact risk is HIGH/CRITICAL. `nexus triage` prints the same decision. `NEXUS_FAST_PATH=0`, `--no-triage`, or `workflow.fastPath: false` keeps the standard pipeline. Standard execution now requires evidence of size, risk, or a safety signal.

### Bounded subagent waits

Plan-advisor, reviewer, and implementer calls have wall-clock budgets of 5, 10, and 20 minutes (`budget_ms` in `nexus.models.json`, or `NEXUS_*_BUDGET_MS`). The plugin watchdog records `TIMED_OUT` and aborts the child session when the host exposes one. `nexus next` skips a timed-out advisor, accepts sealed verification after a timed-out reviewer, and re-dispatches a timed-out implementer once. Reviewer remediation is one round, or two when impact risk is HIGH or CRITICAL. The reviewer agent has a 24-step ceiling.

### Private git baseline

`nexus run init` in a directory that is not already a git work tree creates a private repository, commits the current files as `nexus-baseline` with a repo-local identity, and deletes that `.git` when the run finishes. An existing repository is left untouched, and global git config is never changed. A content-hash snapshot is written only when the `git` binary is missing. Plan-check uses the baseline commit instead of failing on `NO_GIT_REPO`.

### Permission patterns match absolute paths

Orchestrator control-plane writes and implementer control-plane denials use both relative and absolute glob patterns, so OpenCode's absolute-path matching allows `.opencode/**` and still denies implementer edits to run state. The orchestrator may run read-only probes (`ls`, `cat`, `head`, `wc`, `rg`, `find`, `python3 --version`) and `git init`, `git add`, and `git commit`. Package `external_directory` rules use `**/@mohammad154/opencode-nexus/**` instead of a hard-coded `/usr/local/lib` prefix. `nexus install` runs a permission self-test and fails if an orchestrator write to its own plan would be denied. Paths containing `..` stay denied.
