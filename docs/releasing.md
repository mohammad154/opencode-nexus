# Releasing `@mohammad154/opencode-nexus`

This document is for maintainers publishing a new `4.x.y` package version and
GitHub release from `main`.

The package **release line** (`4.x.y`) is separate from the **workflow protocol**
version (v5). Bump only `package.json` / `package-lock.json` for a release;
protocol docs live under `docs/workflow.md`.

## Prerequisites

- Green required checks on the commit you intend to ship:
  - **CI** (matrix tests plus the aggregate `CI` job)
  - **Installer isolation**
  - **Plugin Security Scan**
- Repository secret **`NPM_TOKEN`** — npm automation token with publish access
  to `@mohammad154/opencode-nexus`. Without it, the Release workflow can pass
  tests but fails at `npm publish`.

## Standard release (GitHub Actions)

1. Merge changes to `main` and bump the version:

   ```bash
   # edit package.json and package-lock.json → "version": "4.x.y"
   git commit -m "Release v4.x.y."
   git push origin main
   ```

2. Wait until CI, Installer isolation, and Plugin Security Scan succeed on
   that commit.

3. Run the **Release** workflow (`/.github/workflows/release.yml`) via
   **Actions → Release → Run workflow**:

   | Input | Value |
   |---|---|
   | `version` | The exact `package.json` version (e.g. `4.4.1`) |
   | `commit` | Optional full commit SHA to release; omit to use the workflow ref |

   Use the **full** 40-character commit SHA when pinning a release. Short SHAs
   are not valid checkout refs in the workflow.

4. On success the workflow:

   - Re-runs `npm test` and `npm run test:install`
   - Publishes to [npm](https://www.npmjs.com/package/@mohammad154/opencode-nexus)
   - Creates annotated tag `v4.x.y` and a GitHub release with generated notes

## Manual GitHub release (npm publish later)

If npm credentials are not configured yet, you can still tag GitHub:

```bash
git tag -a v4.x.y <full-commit-sha> -m "Release v4.x.y"
git push origin v4.x.y
gh release create v4.x.y --target <full-commit-sha> --generate-notes
```

Publish to npm later by adding `NPM_TOKEN` and re-running the Release workflow
for the same version only if that version is not already on the registry.

## Local verification before tagging

```bash
npm test
npm run test:install
```

These match the gates the Release workflow runs before publish.
