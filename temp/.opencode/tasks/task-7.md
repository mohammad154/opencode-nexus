# Task 7: Regression, parity, smoke + truthful docs
- id: unit-7
- title: Sharded regression, CPU-GPU parity, smoke, README/RUN, final audit
- commit: 39c66ff (39c66ff3fbd6ac930962f24183cdf27cecfbbf0d)
- base_branch: main
- effort: M
- confidence: HIGH
- dependencies: unit-6

## Evidence
- `README.md:139`, `RUN.md:119` – contract lines to correct.
- `gpu_fuzzy_trader/config.py:237-256` – final 30 to document.

## Scope
- In: README.md, RUN.md, defect-fix sources only if sharded tests fail (minimal), ignored outputs/onchain_smoke evidence.
- Out: no logic changes except verified fixes; no retuning; bench/CUDA full on GPU host only.
- Blast: docs-only + regression; `nexus impact` not needed unless defect fix.

## Acceptance criteria
- [ ] Sharded data/feature/split/MTF, parity+encoder, integrity/RB suites pass.
- [ ] CPU smoke rule_features=30, no violation/reuse/pre-Phase5 test read; GPU smoke on host with hw/JAX/mem/time logged.
- [ ] README: 30 vs context, modes, release, Funding, global/specialist truth, test-diagnostic, forward-only.
- [ ] RUN: exact build/verify/screen/finalist/debug/GPU/diagnostic/forward with split annotations.
- [ ] --help, validate==30, diff-check clean, manifests match tapes+profile, no sources/staged/caches committed.

## STOP conditions
- STOP if baseline on main also fails (record, fix separately).
- STOP if smoke shows leakage/violation/test-read.
- STOP if docs claim unselected mode/profile as production.

## Verification gates
1. Sharded `PYTEST_LOW_MEMORY=1 .venv/bin/python -m pytest <group> -q` ×3 groups – pass (never one giant local run).
2. Smoke + GPU-host smoke – evidence logged.
3. `validate_config==30`, `git diff --check`, manifest/hash audit – clean.

## Graph context
- No new callers; final audit of all prior units.
