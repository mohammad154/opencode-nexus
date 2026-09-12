# Task 2: Atomic enrichment builder
- id: unit-2
- title: As-of join, manifest, staged atomic CLI
- commit: 39c66ff (39c66ff3fbd6ac930962f24183cdf27cecfbbf0d)
- base_branch: main
- effort: M
- confidence: HIGH
- dependencies: unit-1

## Evidence
- `gpu_fuzzy_trader/research_integrity.py:27-33` – sha256_file pattern.
- `gpu_fuzzy_trader/run_pipeline.py:254-256` – duplicate-key guard pattern.

## Scope
- In: `gpu_fuzzy_trader/data/onchain_pipeline.py` (enrich+manifest+verify), `scripts/build_onchain_dataset.py`, `tests/unit/test_onchain_dataset_builder.py`, `.gitignore`
- Out: config/catalog/MTF/RB, real tape replace (unit-5).
- Blast: `nexus impact --json --targets gpu_fuzzy_trader/data/onchain_pipeline.py,scripts/build_onchain_dataset.py`

## Acceptance criteria
- [ ] Backward as-of per symbol, invisible before available_at, preserves rows/order/keys/OHLCV/18 ff_*, adds exactly 12.
- [ ] Deterministic manifest (hashes, coverage, funding_gap); created_at outside hashed contract.
- [ ] Staged *.staged.csv + re-read verify; os.replace only with --replace; failed verify leaves originals intact.
- [ ] Sources/staged ignored; git status clean.

## STOP conditions
- STOP if any original value changes, cols !=+12, or forward-visible.
- STOP if forced-verify-failure modifies original.
- STOP if unit-1 files drifted unexpectedly.

## Verification gates
1. `PYTEST_LOW_MEMORY=1 .venv/bin/python -m pytest tests/unit/test_onchain_dataset_builder.py tests/unit/test_onchain_pipeline.py -q` – pass.
2. `git diff --check` – clean.
3. `git diff main...feature/unit-2-onchain-builder --stat` – only in-scope.

## Graph context
- Exemplar: `research_integrity.py:36-67` dataset_manifest.
