# Task 5: Real dataset build + proof
- id: unit-5
- title: Build staged tapes, suffix replay, atomic replace, verify-only
- commit: 39c66ff (39c66ff3fbd6ac930962f24183cdf27cecfbbf0d)
- base_branch: main
- effort: M
- confidence: MEDIUM
- dependencies: unit-1, unit-2, unit-3

## Evidence
- `data/train_new.csv:1` – 7+18 header to 7+30.
- `gpu_fuzzy_trader/research_integrity.py:27-33` – hash pattern.

## Scope
- In: `data/train_new.csv`, `data/test_new.csv`, `data/onchain_feature_manifest.json` (generated); ignored `data/onchain/source-v1/` (not committed).
- Out: all code frozen; no tuning.
- Blast: data-only; verify hashes, no code callers.

## Acceptance criteria
- [ ] 24 files, 12 new/30 total, Funding 25/25, 0 gaps/dups/changed/range violations.
- [ ] Suffix replay after 2026-07-23 21:45 leaves hashes unchanged.
- [ ] --replace only after staged pass; --verify-only 140352/39152 rows, 37 cols.
- [ ] Isolated commit `data: add causal Santiment features`.

## STOP conditions
- STOP if gaps/changed/range/suffix-dependence or counts differ.
- STOP if snapshot missing or !=24 files.
- STOP if sources/staged appear in git status.

## Verification gates
1. Staged build manifest inspect – counts as above.
2. Suffix replay – hashes unchanged.
3. `--verify-only` – rows/cols as above.
4. `git diff --cached --stat` – only 3 data files.

## Graph context
- No code callers; lineage via manifest hashes.
