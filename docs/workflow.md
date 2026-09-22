# Nexus workflow protocol v5

This protocol document applies to the npm package `4.x.y` release line. The
package version and workflow protocol version are intentionally independent.

For implementation details and operational recovery, see
[`architecture.md`](architecture.md) and [`troubleshooting.md`](troubleshooting.md).

Nexus is a **fixed** three-agent execution workflow for OpenCode. The orchestrator coordinates; the implementer codes; the reviewer stays read-only; **scripts own measurement and gates**. A conditional `plan-advisor` may challenge a plan when the deterministic planning decision requires it, but it is planning-only and never enters the execution loop.

## Three invariants

1. Every request starts with brainstorming and a plan.
2. Every implementer call requires fresh impact analysis.
3. Every implementation must be approved by an independent reviewer.

## Orchestrator-only activation

The Nexus plugin resolves the authoritative primary agent from OpenCode
message metadata and activates only when its exact value is `orchestrator`.
It does not infer identity from model names, prompts, message content, active
run files, or marker text. Build, Plan, custom primaries, and the
`implementer`, `reviewer`, and `plan-advisor` subagents receive no Nexus router,
delegation gate, dispatch instruction, or compaction context. If the identity
is missing or ambiguous, the plugin fails closed.

When a conversation switches away from `orchestrator`, the plugin removes only
explicitly wrapped Nexus-owned injected sections and preserves user-authored
parts. The current OpenCode plugin configuration API exposes skill search paths
globally rather than per primary agent, so Nexus skills may remain discoverable
to other agents; automatic Nexus routing and instructions are still gated by
the exact primary-agent identity.

Before implementation, the controller freezes the normalized scope policy and
an external digest of protected `.opencode` runtime state. A changed control
plane blocks the transition with `CONTROL_PLANE_TAMPERED`; `.opencode/handoffs`
is the deliberate implementer-writable runtime exception. See
[`architecture.md`](architecture.md#runtime-integrity-control-plane-and-policy-snapshots)
for the protected path list and snapshot behavior.

## Continuous execution and user boundaries

Nexus is continuous after planning: the orchestrator executes deterministic
gates, dispatches the required subagents, consumes handoffs, resumes
verification, runs reviewer fix loops, and finishes the selected branch policy
without asking the user to say “continue”, “test”, “review”, or “fix”.

During `BRAINSTORMING`, ask one consolidated round covering the whole current
decision frontier, with recommendations. Repository, Git, impact, and test
facts are obtained by tools or read-only agents; the user answers decisions.
`WAITING_FOR_USER` is reserved for this planning clarification boundary.

Routine local merge and ancestry-checked cleanup are automatic under the
default `always_to_base` / `branch_cleanup_policy: always` policy. Ask only for
`merge_policy: prompt` or a critical operation: push/PR publication,
force-discard, destructive migration/data loss, secrets, deployment/external
side effects, or a material scope/acceptance change. A sealed final review and
verification authorize `COMPLETED`, not unrelated external side effects.

## Lifecycle

```text
request → brainstorm → (optional plan-advisor) → plan → plan-check → (per execution unit) pre-impact → implement → VERIFYING → deterministic verify → review → FINAL_VERIFYING → deterministic final verify → finish
```

Durable state: `.opencode/runs/<run-id>/state.json`

## Planning depth and the planning challenge

These are two separate decisions, both derived deterministically in
`scripts/lib/planning.js` from reported evidence.

**Depth** (`planning_mode`) follows semantic risk first and size second:

| Mode | When |
|---|---|
| `compact` | one cohesive unit, established implementation pattern, impact known and not HIGH/CRITICAL, review surface within 5 files / 150 lines, and no semantic signal |
| `standard` | ordinary features; also any architectural choice, multi-subsystem change, or unresolved decision |
| `deep` | public contract, security boundary, migration, destructive change, HIGH/CRITICAL/UNKNOWN impact, or >8 files / >400 lines / >5 units |

The semantic signals are `PUBLIC_CONTRACT`, `SECURITY_BOUNDARY`, `MIGRATION`,
`DESTRUCTIVE_CHANGE`, `ARCHITECTURAL_CHOICE`, `MULTI_SUBSYSTEM`,
`UNRESOLVED_DECISION`, `HIGH_IMPACT`, and `UNKNOWN_IMPACT`. Size alone no longer
decides: three files and eighty cohesive lines can be compact, while fifteen
lines of authentication behavior cannot. Compact requires *positive* evidence of
cohesion and a known pattern — an unclassified change is planned as `standard`.

**Challenge** (`plan_advisor_decision`) is independent of depth:

```text
hard safety signal        → REQUIRED
deep planning             → REQUIRED
explicit uncertainty      → REQUIRED
evidence too thin to judge→ REQUIRED   (fail closed)
clear cohesive task       → NOT REQUIRED
```

So `planning_mode: standard` with `plan_advisor_required: false` is a normal,
explainable outcome. The decision is persisted with `reason_codes`:

```json
{
  "plan_advisor_decision": {
    "required": false,
    "reason_codes": [
      "SINGLE_COHESIVE_UNIT",
      "KNOWN_IMPLEMENTATION_PATTERN",
      "NO_ARCHITECTURAL_CHOICE",
      "IMPACT_NOT_HIGH",
      "NO_HARD_TRIGGER",
      "NO_EXPLICIT_UNCERTAINTY"
    ]
  }
}
```

Guardrails:

- The orchestrator reports evidence; Nexus derives the decision. A caller claim
  can only *raise* `required`, never clear a deterministic trigger.
- An explicit `compact` claim is rejected at `PLANNED` when a semantic signal
  disqualifies compact planning, so depth cannot be used to dodge the challenge.
- `BRAINSTORMING → PLANNED` fails closed when the decision requires a challenge
  and no independent advisor handoff exists. It does **not** demand a fabricated
  advisor artifact when the challenge is not required.
- A decision without an explicit boolean `required` and at least one reason code
  is discarded, and the conservative mode-only fallback applies.
- Deep planning keeps one mandatory advisor call; the second call remains limited
  to a documented `CRITICAL_DISAGREEMENT`.
- The agent-call estimator and the runtime budget both read the persisted
  decision, so the allowance matches what the workflow will actually spend.


States: `CREATED` → `BRAINSTORMING` ↔ `WAITING_FOR_USER` → `PLANNED` → `TASK_IMPACT_READY` → `IMPLEMENTING` → `VERIFYING` → `REVIEWING` → (`TASK_IMPACT_READY` on REQUEST_CHANGES / eligible failed verification / next unit) → `FINAL_REVIEWING` → `FINAL_VERIFYING` → `COMPLETED`

```text
Implementer
    ↓
IMPLEMENTING → VERIFYING (PENDING)
    ↓ nexus verify
Deterministic verification (not an LLM agent)
    ↓ PASSED
REVIEWING → Reviewer (independent LLM agent)
    ↓
FINAL_REVIEWING → FINAL_VERIFYING (PENDING)
    ↓ nexus verify
Deterministic final verification → COMPLETED
```

The two transitions into verification states are fast and persist only the
handoff binding plus `verification_status: PENDING`. `nexus verify` owns fresh
post-impact, plan discovery, checks, timeouts, progress, and sealed evidence;
it does not transition to `REVIEWING` or `COMPLETED` itself.

`nexus verify` is the **single authoritative owner** of the required ladder
(tests, lint, typecheck, build, post-impact, workspace integrity, sealed
evidence). The implementer runs only development-feedback checks — the new
regression test, a targeted unit test, a quick compile or focused type check,
TDD red/green — and reports them as `development_checks` (the legacy
`verification_gates` field remains an accepted alias with the same meaning).
Those reports are never authorization; `VERIFYING → REVIEWING` still requires a
sealed `PASSED` provider artifact.

### Evidence reuse

An expensive check is re-executed unless Nexus can prove it already measured the
same *evidence identity*: HEAD, workspace content digest, argv, timeout
configuration, scope policy, dependency lockfiles, and toolchain. Under that
rule:

- `FINAL_VERIFYING` reuses identity-matched `PASSED` task results and executes
  only the checks the final requirement adds.
- A sealed, passing TDD green run satisfies an identical verification step when
  the workspace did not change across the red/green measurement.
- A repeated `TASK_IMPACT_READY` at an unchanged impact identity reuses the
  sealed analysis instead of recomputing it.

Reuse never weakens a gate. Failures, timeouts, unavailable and skipped results
always re-execute; a broken seal, an `UNKNOWN` analysis, or any unmeasurable
identity component falls back to recomputation. Reuse candidates come only from
evidence this engine sealed into orchestrator-owned run state — a cache file or
caller-supplied report is forgeable and authorizes nothing. See
[`docs/architecture.md`](architecture.md#evidence-identity-and-reuse).

Use `nexus next` for the exact action. In particular, `PENDING` means
`nexus verify`, `RUNNING`/`TIMED_OUT` mean `nexus verify --resume`, and `PASSED`
means run the corresponding authorization transition. For a `FAILED` result,
`nexus next` automatically performs one fresh-impact repair only when the
sealed artifact is bound to current HEAD, the workspace measurement is
available and clean, and an executable check actually failed. Timeout,
unavailable, stale, dirty, and other non-repairable failures remain manual;
there is no verifier subagent.

Capture a verification baseline only before implementation starts. Nexus seals
the baseline and binds it to the exact pre-implementation HEAD; a baseline
captured from a later implementation/review state or with a different commit
cannot waive verification failures.

## Impact Engine

```bash
nexus impact --json
nexus run transition --to TASK_IMPACT_READY
```

Pre-impact before every implementer (including fix loops). `nexus verify` runs
fresh post-impact while the run remains in `VERIFYING` or `FINAL_VERIFYING`.

An execution unit may contain several implementation steps. The implementer
runs each step's targeted check as work progresses. These checks are implementer
development feedback, not separate Nexus verification states: Nexus does not
persist or authorize each internal step independently, and the implementer is
not expected to pre-run the unit's full authoritative ladder. After the complete
unit, deterministic `nexus verify` must pass before its one task reviewer is
dispatched.

Verification intensity follows impact risk. LOW runs the related tests plus lint
and does not additionally run the whole suite over the same code; the full suite
is still required when there is no executable targeted evidence, or on low
confidence, unknown impact, incomplete analysis, a public contract change, scope
escalation, a baseline requirement, or explicit project policy. MEDIUM, HIGH,
and CRITICAL remain conservative and always include the full suite.

## Review

Only after task verification is `PASSED`: run `nexus review-package --scope task`
then dispatch `reviewer`. A pending, failed, running, or timed-out verification
never dispatches a reviewer.

After the last task APPROVED: `nexus review-package --scope final` then dispatch
`reviewer` again (`review_scope: final`) before `FINAL_VERIFYING`. Final packages
use immutable `run_base_commit..HEAD` (whole branch), not the last task's
pre-head. They include a `Previous task review evidence` section with task
approval handoffs/packages and their bindings. Reuse a prior result only when
`review_evidence_bound: true`, `files_changed_after_review` is available, and
the files owning that criterion are absent from the list. The final reviewer
confirms the recorded unit, reviewed commit, and package digest, then focuses on
cross-unit integration and changes since the approvals. Reopen criteria with
changed owning files, missing/unbound/stale evidence, a missing post-review file
list, or an integration defect. The final whole-branch reviewer remains
mandatory for every multi-unit run.

For a genuinely single-unit run, the task review may be reused for
`FINAL_VERIFYING` only when the caller opts in and Nexus can bind the same
reviewed commit to the current `HEAD`, recompute the review-package digest, and
confirm that no code outside `.opencode/` changed after review. Any failed
binding, changed byte, or additional unit falls back to the whole-branch final
review path.

Verdicts: `APPROVED` | `REQUEST_CHANGES`. Approvals require evidence (all persisted acceptance criteria, mandatory checks, production-file coverage in `files_reviewed` or explicit `files_skipped`, bound review-package digest); empty APPROVED is gate-invalid.

On an eligible verification `FAILED`, the orchestrator automatically re-impacts and re-dispatches the implementer once; this is separate from reviewer `REQUEST_CHANGES` remediation. On `REQUEST_CHANGES`, it automatically re-impacts and re-dispatches the implementer — the user does not need to ask for fixes. Reviewer remediation is capped at three attempts per execution unit. After `VERIFICATION_REPAIR_EXHAUSTED`, `FIX_LOOP_EXHAUSTED`, or `AGENT_CALL_BUDGET_EXCEEDED`, it must transition to `BLOCKED` and reconcile instead of dispatching another subagent.

For any transition that consumes a handoff, pass the complete handoff file rather than reconstructing a partial object: `--implementer-handoff-file .opencode/handoffs/<id>-implementer.json` or `--review-handoff-file .opencode/handoffs/<id>-reviewer.json`. This preserves the acceptance and evidence required by the state gate.

Planted-defect reviewer evals (deterministic oracle + rubber-stamp suites):

```bash
nexus eval reviewer
nexus eval reviewer --json
```

Metrics: `defect_recall`, `false_positive_rate`, `unsupported_finding_rate`, `approval_of_bad_patch_rate`.

## Agent roster

```text
orchestrator  (execution controller)
implementer   (execution unit implementation)
reviewer      (unit review + multi-unit final integration review)
plan-advisor  (conditional planning-only challenge; not in the execution loop)
```

## Inspect / next step

```bash
nexus next                 # deterministic next orchestrator action
nexus next --json
nexus run inspect --run-id <id>
nexus estimate --tasks 3
nexus run transition --to PLANNED --plan-check
```

`task-*` identifiers remain accepted for V5 compatibility, but new plans should
use **Execution Unit** headings. Each unit should be cohesive, independently
verifiable, reviewable, and safe. Each unit must state `user_outcome`,
`independently_shippable`, `review_boundary`, and `estimated_lines`. Use
`review_boundary: NONE` unless an independent boundary applies; valid boundary
values are `PUBLIC_CONTRACT`, `SECURITY_BOUNDARY`, `MIGRATION_BOUNDARY`,
`INDEPENDENT_ROLLBACK`, `INDEPENDENT_SHIPPING`, `REVIEW_SIZE_LIMIT`, and
`SUBSYSTEM_BOUNDARY`. Add an `## Execution Unit Justification` section explaining
why the plan has neither fewer nor more units (required for standard/deep plans
and for any plan with more than one unit; a single-unit compact plan omits it). Internal steps are not units.

Merge dependent units by default when they are not independently shippable and
their combined scope fits the configured reviewer-audit limits, unless a named
review boundary justifies keeping them separate. A `KEEP_SEPARATE` disposition
must use one of the seven boundary codes above as `reason_code`, plus a concrete
evidence-based explanation. `MERGED` is valid only after the plan is revised;
rerun `nexus plan-check` until no merge-candidate warning for those units
remains, then remove the stale disposition.

Planning depth is `compact`, `standard`, or `deep`. Compact planning skips the
advisor; standard planning uses one advisor call; deep planning uses one call
and permits a second only for an explicit `CRITICAL_DISAGREEMENT`.

### Mode-aware PLAN contract

Planning depth also selects how much plan a change has to pay for. Every mode
requires the same safety content — planning mode, plan/base commit, goal,
non-goals, and for every execution unit `user_outcome`,
`independently_shippable`, `review_boundary`, `estimated_lines`, evidence,
allowed files, acceptance criteria, verification gates, and STOP conditions.
`nexus plan-check` reports a missing one as `MISSING_PLAN_GOAL`,
`MISSING_PLAN_NON_GOALS`, `MISSING_PLAN_COMMIT`, `MISSING_ALLOWED_FILES`,
`MISSING_UNIT_EVIDENCE`, or `MISSING_STOP_CONDITIONS`.

| Mode | Additional required narrative |
|---|---|
| `compact` (exactly one unit) | none — minimal safe plan |
| `standard` | `## Execution Unit Justification` plus the context the change needs |
| `deep` | full template: findings triage, dependency graph, global verification strategy, rollback, outcome memory |

`plan-check` exposes the applied contract as `contract.required_sections` and
`contract.relaxed_sections`. A compact plan with more than one execution unit
gets the advisory `COMPACT_PLAN_MULTIPLE_UNITS` warning and must satisfy the
standard contract.

A PLAN that declares `Planning mode: compact` never authorizes compact planning
by itself: the `PLANNED` gate re-derives compact admissibility from planning
evidence, so a structurally valid compact plan for a security boundary, public
contract, migration, destructive change, or HIGH/UNKNOWN impact still fails.

### Generated execution-unit views

`.opencode/tasks/task-N.md` is generated deterministically from `PLAN.md` at the
`PLANNED` transition (`scripts/lib/task-artifacts.js`), so the planner writes the
semantics once:

```text
PLAN.md    = semantic planning authority
run state  = execution authority
task-N.md  = generated compatibility/execution view
```

Each generated file carries a `GENERATED BY NEXUS` header bound to the plan
digest and unit id. Nexus regenerates the views when the plan changes and removes
only stale files it can prove it generated; user-authored files under
`.opencode/tasks` are preserved and never overwritten. Run state records the
materialization as `task_artifacts` (advisory, generated view — not gate
evidence).

### Cached project recon

```bash
nexus project-profile --json      # advisory, cached repository-level facts
nexus project-profile --refresh
```

The profile caches repository-level facts only — ecosystem, package manager,
build/test/lint/typecheck commands, CI config paths, AGENTS/CLAUDE/CONTRIBUTING
locations, intent/ADR locations, memory locations, base branch, root config
metadata — in `.opencode/cache/project-profile.json`, keyed by the content of
those source files. An unrelated source commit does not invalidate it; editing
`package.json`, CI config, or an agent guide does. It is advisory: it cannot
authorize `PLANNED`, `TASK_IMPACT_READY`, `VERIFYING`, `REVIEWING`, or
`COMPLETED`, and it never holds task-specific conclusions — the planner still
reads the target implementation, its tests, its callers, and any applicable
design/ADR.

`nexus next` (and the plugin’s injected **Nexus Next Action** block) tells the orchestrator what to do now — including `REQUIRED_DISPATCH: implementer|reviewer` when a Task dispatch is mandatory.

The standalone `nexus plan-check` command is diagnostic. To authorize the
`PLANNED` transition, use `nexus run transition --to PLANNED --plan-check` so
the passing report is attached to durable run state.

Before `PLANNED`, every actionable `plan-check` warning must have a matching
`MERGED` or `KEEP_SEPARATE` disposition with a reason. This keeps heuristic
decomposition findings advisory while making the final granularity decision
explicit and auditable.
