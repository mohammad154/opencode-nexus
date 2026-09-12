# Task 4: Explicit Phase 2 symbol modes
- id: unit-4
- title: global vs specialist routing + provenance
- commit: 39c66ff (39c66ff3fbd6ac930962f24183cdf27cecfbbf0d)
- base_branch: main
- effort: M
- confidence: MEDIUM
- dependencies: unit-3

## Evidence
- `gpu_fuzzy_trader/config.py:237-256` – config pattern.
- `gpu_fuzzy_trader/run_pipeline.py:212-276` – slice/merge isolation pattern.

## Scope
- In: config.py (PHASE2_SYMBOL_MODE), run_pipeline.py (_run_phase2_global/_specialists), phases/phase2_rule_pool.py (slicing+provenance), tests/unit/test_phase2_symbol_modes.py
- Out: RB values (unit-6), catalog (frozen), real data (unit-5).
- Blast: `nexus impact --json --targets gpu_fuzzy_trader/run_pipeline.py,gpu_fuzzy_trader/phases/phase2_rule_pool.py`

## Acceptance criteria
- [ ] Invalid mode fails validate_config; default global preserves behavior; mode logged.
- [ ] Specialist per (symbol,direction) isolated slices + island_hyperparams; single-symbol provenance; no migration; fail-closed multi-symbol.
- [ ] Provenance survives Phase2→RB.

## STOP conditions
- STOP if global outputs change vs main snapshot.
- STOP if cross-symbol rows shared or provenance lost/rewritten.
- STOP if empty folds crash (must fail-closed).

## Verification gates
1. `PYTEST_LOW_MEMORY=1 .venv/bin/python -m pytest tests/unit/test_phase2_symbol_modes.py tests/unit/test_rb_island_source_symbols.py tests/unit/test_run_pipeline.py -q` – pass.
2. `git diff main...feature/unit-4-symbol-modes --stat` – only in-scope.

## Graph context
- Callers: run_pipeline→phase2 pool→RB governor; verify serialization.
