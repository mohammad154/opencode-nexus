# Run succession: santiment-onchain-20260910 → santiment-onchain-20260910-r2

## Why
The original run was initialized with default budget units=1 (max 6 agent
calls). The 7-unit deep plan needs ~15 calls (ceiling 23). Nexus computes the
budget ceiling as min(existing max, derived) on every charged transition, so
once fixed at 6 it can never grow within the same run, even after persisting
`execution_units`. After 6 charges (advisor + unit-1 impl/rev + unit-1 fix
impl/rev x2 + unit-2 impl), the REVIEWING→TASK_IMPACT_READY transition for the
unit-2 fix loop was rejected with AGENT_CALL_BUDGET_EXCEEDED (6+1 > 6).

## What carries over (nothing re-implemented)
- Git branches/commits: feature/unit-1-onchain-core (604bec3, APPROVED),
  feature/unit-2-onchain-builder (5fed2f1, implemented, fix pending).
- Plan: .opencode/plans/PLAN.md + tasks unchanged, same plan-check report.
- Plan-advisor handoff: same deep/REVISE handoff replayed at PLANNED.
- Baseline waiver: baseline.json copied to the new run directory verbatim
  (same 2 pre-existing failures, evidence in BASELINE_EVIDENCE_UNIT2.md).
- Full audit trail stays in the old run's trajectory/state (abandoned in
  REVIEWING, never deleted).

## What the new run redoes (no wasted implementation)
- Starts at unit-2 fix loop: TASK_IMPACT_READY → IMPLEMENTING (reuse
  feature/unit-2-onchain-builder) → implementer (F-1..F-6) → VERIFYING →
  REVIEWING → units 3-7 → FINAL.
- task_history restarts; unit-1 APPROVED lives in old run + branches.
- Budget: execution_units=7 persisted at PLANNED → ceiling 23, ~15 needed.

---

# Run succession: santiment-onchain-20260910-r2 → santiment-onchain-20260910-r3

## Why
r2 exhausted its agent-call budget (used 23+1 > max 23) at the unit-4 fix
IMPLEMENTING→VERIFYING transition. Same structural ceiling as r1: the budget
is min(requested, derived) and usage never resets within a run. Six unit-3
fix loops consumed the headroom.

## What carries over (nothing re-implemented)
- Git branches/commits: unit-1 (604bec3, APPROVED), unit-2 (856f501c,
  APPROVED), unit-3 (ba0c92c, APPROVED), unit-4 (7ea1c4e implemented,
  f3358e2 fix addressing F-1..F-4 + F-5/F-6, on
  feature/unit-4-symbol-modes).
- Plan: .opencode/plans/PLAN.md + tasks unchanged; plan-advisor REVISE
  handoff replayed at PLANNED; execution_units=7 → ceiling 23, fresh counter.
- Baseline waiver: baseline.json copied r2→r3 verbatim (same 2
  pre-existing failures, BASELINE_EVIDENCE_UNIT2.md).
- Full audit trail stays in r2 trajectory/state (stuck at IMPLEMENTING).

## What the new run redoes
- Unit-4 fix loop gates only: TASK_IMPACT_READY → IMPLEMENTING (reuse
  feature/unit-4-symbol-modes) → VERIFYING (handoff f3358e2) → REVIEWING →
  then units 5-7 → FINAL. No code re-implementation.
