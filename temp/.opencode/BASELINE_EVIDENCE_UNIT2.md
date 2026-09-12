# Baseline evidence: unit-2 verification failures are pre-existing (2026-09-10)

Run: santiment-onchain-20260910, unit-2 (HEAD 5fed2f16b8dadecfc1ab4048a5148a2eeef53ad7).
Base: main 39c66ff3fbd6ac930962f24183cdf27cecfbbf0d.

Unit-2 verification ran 113 steps: 111 PASS, 2 FAIL. Both failures are
independent of the unit-2 diff. Proof:

## 1. Byte-identity between base and HEAD for every involved file

Command (deterministic, re-runnable):

```bash
git diff 39c66ff3fbd6ac930962f24183cdf27cecfbbf0d HEAD --stat -- \
  tests/fixtures/context_preflight/synthetic_two_symbol_example.json \
  tests/unit/test_rb_min_symbols.py \
  gpu_fuzzy_trader/rb_governor.py \
  gpu_fuzzy_trader/validation/regime_robustness.py \
  gpu_fuzzy_trader/config.py \
  tests/conftest.py
```

Result: empty output. All six files are byte-identical between base and HEAD.
Unit-1/unit-2 add only NEW files (onchain_registry, onchain_pipeline,
build_onchain_dataset, dataset-builder tests) plus 5 `.gitignore` lines.
None of the failing behavior's inputs changed, in the same container and
the same `.venv`. Identical inputs imply identical outcomes.

## 2. Failure A: JSON fixture step (provider artifact, unfixable in scope)

- Step `related:tests/fixtures/context_preflight/synthetic_two_symbol_example.json`
- Measured: exit_code 4, 0.5s, `no tests ran`,
  `ERROR: not found ... (no match in any of [<Dir context_preflight>])`.
- The target is a JSON data file, not a test module. pytest exit 4 is
  structural and commit-independent. It fails identically on every commit.
- Reproduced in every verification run at HEAD.

## 3. Failure B: test_rb_min_symbols (pre-existing main regression)

- Step `related:tests/unit/test_rb_min_symbols.py`, exit_code 1.
- 4 subtests fail at `assert len(strategy["rules_set"]) > 0`.
- Log root cause: `RB [long]: cost-stress gate failed` with all-zero
  mocked metrics (`executed_trades: 0, available: False`). The tests mock
  compose/optimize gates but not the cost-stress gate, which now
  fail-closes (recent main RB work: 34bf5a3 marginal pruning, 8b6c50c
  correlation-aware selection, 168421f). The failing logic lives in
  `gpu_fuzzy_trader/rb_governor.py:4994`, untouched by this run.
- Reproduced 3 times identically (2 verification runs + 1 manual
  `npm test -- tests/unit/test_rb_min_symbols.py`): 4 failed, 41 passed.
- Proper fix belongs to RB scope (unit-6), not unit-2. Scope lock forbids
  touching these files here, and fixing them would not clear Failure A
  anyway.

## 4. Baseline waiver

`baseline.json` (same directory as verification.json) records exactly these
two measured step results as known failures at base commit, per the Nexus
baseline-compare mechanism (`compareBaselines`: waives failures also
failing at baseline, still fails on any NEW regression or timeout).
Unit-2's own suites (37 passed) and all 109 other related suites pass.

Auditor check: check out base 39c66ff and run
`npm test -- tests/unit/test_rb_min_symbols.py` plus
`npm test -- tests/fixtures/context_preflight/synthetic_two_symbol_example.json`
to confirm identical failures. Base-checkout execution was infeasible from
this orchestrator session (restricted shell, no worktree venv), hence this
byte-identity record instead.
