# Task 3: Thirty-feature runtime contract + lineage
- id: unit-3
- title: Catalog 30, MTF retention, bounded scaling, RSI dedup, digest
- commit: 39c66ff (39c66ff3fbd6ac930962f24183cdf27cecfbbf0d)
- base_branch: main
- effort: M
- confidence: HIGH
- dependencies: unit-1, unit-2

## Evidence
- `gpu_fuzzy_trader/features/catalog.py:26-48,69-80` – allowlist + specs.
- `gpu_fuzzy_trader/run_pipeline.py:234-246` – base_columns filter to extend.
- `gpu_fuzzy_trader/features/fuzzy_scaling.py:133-190` – ordinal manifest to add bounded_continuous.
- `gpu_fuzzy_trader/data/multi_timeframe.py:251-254` – rsi_14 duplicate.
- `gpu_fuzzy_trader/config.py:2693-2701` – 18-check to 30.

## Scope
- In: config.py, features/catalog.py, features/fuzzy_scaling.py, data/multi_timeframe.py, run_pipeline.py, research_integrity.py, tests test_onchain_feature_contract/test_feature_catalog/test_fuzzy_scaling/test_mtf_pipeline_integration/test_multi_timeframe/test_research_integrity/test_run_pipeline
- Out: symbol routing (unit-4), RB/ablation (unit-6), real tapes (unit-5).
- Blast: `nexus impact --json --targets gpu_fuzzy_trader/config.py,gpu_fuzzy_trader/features/catalog.py,gpu_fuzzy_trader/run_pipeline.py`

## Acceptance criteria
- [ ] supplied_ff == ordered 30, no lwc_/mtf_; generated_lwc preserves old path; missing fails.
- [ ] MTF retains allowlisted ff_* only; drops arbitrary ff_*/hwc_*/mwc_*.
- [ ] bounded_continuous passthrough; out-of-range fails pre-Phase2.
- [ ] rsi_14 removed, midline kept, values unchanged.
- [ ] feature_contract_digest covers names+mode+registry+transforms+manifest; mismatch rejects caches.

## STOP conditions
- STOP if catalog !=30, leak, or stale cache survives.
- STOP if RSI values change or scaling fits on val/test.
- STOP if drift >50 commits.

## Verification gates
1. `PYTEST_LOW_MEMORY=1 .venv/bin/python -m pytest tests/unit/test_onchain_feature_contract.py tests/unit/test_feature_catalog.py tests/unit/test_fuzzy_scaling.py tests/unit/test_mtf_pipeline_integration.py -q` – pass.
2. `PYTEST_LOW_MEMORY=1 .venv/bin/python -m pytest tests/unit/test_multi_timeframe.py tests/unit/test_research_integrity.py tests/unit/test_run_pipeline.py -q` – pass.
3. `.venv/bin/python -c "from gpu_fuzzy_trader import config; config.validate_config(); print(len(config.RULE_ALLOWED_FF_FEATURES))"` – 30.

## Graph context
- Top importers: catalog←run_pipeline, rb_governor; config fan-in high.
