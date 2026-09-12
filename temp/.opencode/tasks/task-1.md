# Task 1: Causal on-chain core
- id: unit-1
- title: Registry, audit, Funding repair, aggregation, causal transforms
- commit: 39c66ff (39c66ff3fbd6ac930962f24183cdf27cecfbbf0d)
- base_branch: main
- effort: L
- confidence: HIGH
- dependencies: none

## Evidence
- `gpu_fuzzy_trader/data/multi_timeframe.py:27-35` – UTC convention to follow.
- `gpu_fuzzy_trader/features/fuzzy_scaling.py:106-130` – fail-closed range pattern.
- `gpu_fuzzy_trader/config.py:237-256` – 18 allowlist (extended in unit-3, not here).

## Scope
- In: `gpu_fuzzy_trader/data/onchain_registry.py`, `gpu_fuzzy_trader/data/onchain_pipeline.py`, `tests/unit/test_onchain_registry.py`, `tests/unit/test_onchain_pipeline.py`
- Out: config, catalog, run_pipeline, multi_timeframe runtime, scripts/builder, data/*.csv, RB/ablation.
- Related callers / blast: new module (no callers yet); future units 2/3. Run `nexus impact --json --targets gpu_fuzzy_trader/data/onchain_registry.py,gpu_fuzzy_trader/data/onchain_pipeline.py` before dispatch.

## Acceptance criteria
- [ ] 12 specs, unique ff_oc_*, version 1.0.0, Funding only allow_gap, windows 2160/720 hourly 180/30 daily.
- [ ] Audit rejects duplicates/non-finite/missing/unsupported/non-Funding gaps with exact tokens.
- [ ] Funding 25-row past-only carry; >8h fails; no bfill/interpolate/fillna(0).
- [ ] Aggregation closed-bucket + available_at correct; suffix-invariant; daily D+1 02:00.
- [ ] Prior-only per-symbol scaling bounded [-1,1], warm-up NaN, constant→NaN, suffix-invariant.

## STOP conditions
- STOP if suffix mutation changes earlier value, daily early-visible, finite outside [-1,1], or unexpected gap.
- STOP if baseline on main already fails or another branch created the registry file.
- STOP if drift >50 commits or base_branch changed.

## Verification gates
1. `PYTEST_LOW_MEMORY=1 .venv/bin/python -m pytest tests/unit/test_onchain_registry.py tests/unit/test_onchain_pipeline.py -q` – all pass.
2. `git diff --check` – clean.
3. `git diff main...feature/unit-1-onchain-core --stat` – only 4 in-scope files.

## Graph context
- Top importers: none (new). Pattern exemplar: `features/catalog.py:26-48`.
