# Task 6: RB profiles + registered ablations + freeze
- id: unit-6
- title: RB resolver, variant matrix, paired gates, ledger, onchain_v1.json
- commit: 39c66ff (39c66ff3fbd6ac930962f24183cdf27cecfbbf0d)
- base_branch: main
- effort: L
- confidence: MEDIUM
- dependencies: unit-3, unit-4, unit-5

## Evidence
- `gpu_fuzzy_trader/rb_governor.py:2009-2018` – silent override to replace.
- `gpu_fuzzy_trader/research_integrity.py:70-80` – ledger pattern.

## Scope
- In: config.py (RB_PROFILE/PROFILES), rb_governor.py (resolver, remove override), optuna_search.py, scripts/run_onchain_ablation.py, tests/unit/test_onchain_ablation.py, profiles/onchain_v1.json (after evidence only)
- Out: production default flip (only on pass), test/forward tuning, docs (unit-7).
- Blast: `nexus impact --json --targets gpu_fuzzy_trader/rb_governor.py,gpu_fuzzy_trader/optuna_search.py,scripts/run_onchain_ablation.py`

## Acceptance criteria
- [ ] Families+variants registered; selection_splits never test/forward (role-based, not filename).
- [ ] Fixed seeds screening/finalist; identical budgets.
- [ ] advances = 4/5 + median>0 + worst-seed + stress + coverage; no test in score.
- [ ] Runner rejects test as selection with `selection data`; ledger appends all fields.
- [ ] Freeze before selection-consume, hash+ledger, one-shot eval, no post-fail tuning; defaults update only on pass else 18-baseline + experimental builder.

## STOP conditions
- STOP if test/forward used for selection or ledger incomplete.
- STOP if budgets/seeds differ or gate bypassed.
- STOP if selection consumed twice or tuned after fail.

## Verification gates
1. `PYTEST_LOW_MEMORY=1 .venv/bin/python -m pytest tests/unit/test_onchain_ablation.py tests/unit/test_rb_correlation.py tests/unit/test_marginal.py tests/unit/test_optuna_search.py -q` – pass.
2. Screening to outputs/onchain_screening_v1 – paired report.
3. Finalists to outputs/onchain_finalists_v1 – frozen profile + ledger.

## Graph context
- Callers: ablation→Phase2→RB→ledger; split-role guard critical.
