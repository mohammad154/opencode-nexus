# Branch Cleanup (V3 — script-first)

**Do not dispatch an LLM implementer for branch deletion.** Use the guarded script:

```bash
git checkout <base-branch>
bash scripts/nexus-branch-cleanup.sh --base <base-branch> \
  --out .opencode/handoffs/plan-cleanup.json \
  feature/<slug> [feature/<other> ...]
```

- Merged branches: default `git branch -d` after `merge-base --is-ancestor` check.
- Discarded unmerged: pass `--force-discard` (uses `-D`) only for those names.
- Protected: never deletes `main`/`master`/`develop`/`base_branch`.

Fallback (only if script missing): the legacy implementer cleanup prompt below.

---

## Legacy fallback template (avoid)

```text
You are performing branch cleanup (not implementation).
Prefer telling the orchestrator to run scripts/nexus-branch-cleanup.sh instead.

If you must proceed:
1. Confirm on [base-branch]
2. For merged: git branch -d <branch> only if ancestor of base
3. For discarded: git branch -D <branch>
4. Write .opencode/handoffs/plan-cleanup-implementer.json
```
