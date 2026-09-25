/**
 * Impact provider interface. V4+ backend is Nexus Impact Engine.
 *
 * Sealed digests are integrity/audit markers only — never authenticity.
 * Safety-critical callers must always recompute via analyzeImpact.
 *
 * This provider never decides to reuse evidence. It computes and publishes an
 * `impact_identity` so a trusted owner of run state (the state machine) can tell
 * whether an analysis it previously sealed is still valid for the current
 * identity. A cache file or caller-supplied report is forgeable and must never
 * authorize anything.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { analyzeImpact } from "../impact/analyze.js";
import { validateContainedPath } from "../filesystem-boundary.js";
import { inspectWorkspace } from "../workspace-integrity.js";
import { IMPACT_ANALYZER_VERSION, impactIdentity } from "../evidence-identity.js";

function gitHead(worktree) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return String(r.stdout || "").trim() || null;
}

function identityPhase(ctx = {}) {
  if (ctx.phase) return String(ctx.phase);
  return ctx.post_impact === true ? "post" : "pre";
}

/**
 * Identity of the analysis `ctx` describes.
 *
 * Impact reads the working tree, not just the commit, so HEAD alone is not a
 * sufficient identity: the workspace digest is required. Returns null when the
 * identity cannot be measured, which forces recomputation.
 */
export function computeImpactIdentity(ctx = {}) {
  const worktree = ctx.worktree || process.cwd();
  const head = ctx.worktree_head || gitHead(worktree);
  if (!head) return null;
  const workspace = ctx.workspace || inspectWorkspace(worktree);
  if (workspace?.available !== true || !workspace.workspace_digest) return null;
  return impactIdentity({
    analyzer_version: IMPACT_ANALYZER_VERSION,
    head,
    workspace_digest: workspace.workspace_digest,
    base: ctx.base || "HEAD",
    phase: identityPhase(ctx),
    change_class: ctx.change_class || ctx.changeClass,
    targets:
      ctx.planned_targets || ctx.targets || ctx.allowed_files || ctx.files,
    policy_digest: ctx.policy?.policy_digest || null,
  });
}

/**
 * Cache files are hints only. Fresh analysis always wins; digests never
 * establish provenance.
 */
function mergeCacheHint(cached, fresh, head) {
  if (!cached || typeof cached !== "object") return fresh;
  const merged = { ...fresh };
  if (cached.worktree_head && head && cached.worktree_head !== head) {
    merged.cache_rejected = "stale_head";
  }
  if (cached.phase === "pre" && fresh.phase === "post") {
    merged.pre_impact_resolved = true;
  }
  if (cached.risk && fresh.risk && cached.risk !== fresh.risk) {
    merged.risk_drift = { from: cached.risk, to: fresh.risk };
  }
  merged.cache_hint_used = true;
  return merged;
}

export function createNexusImpactProvider() {
  return {
    mode: "nexus-impact",
    supported: true,
    capability: "impact-analysis",
    quality: "nexus-impact",
    computeIdentity(ctx = {}) {
      return computeImpactIdentity(ctx);
    },
    analyze(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      const head = gitHead(worktree);
      const identity =
        ctx.impact_identity ||
        ctx.identity ||
        computeImpactIdentity({ ...ctx, worktree, worktree_head: head });

      // Never trust caller-supplied sealed reports as provenance.
      // Always recompute; digests are audit-only after sealing by the state machine.
      const analyzeOpts = {
        base: ctx.base || "HEAD",
        change_class: ctx.change_class || ctx.changeClass,
        planned_targets:
          ctx.planned_targets ||
          ctx.targets ||
          ctx.allowed_files ||
          ctx.files,
        phase: ctx.phase || (ctx.post_impact ? "post" : undefined),
        post_impact: ctx.post_impact === true,
        policy: ctx.policy,
        ...(ctx.policy?.ignored_patterns
          ? { ignoredPatterns: ctx.policy.ignored_patterns }
          : {}),
      };

      let cached = null;
      if (ctx.reportPath && fs.existsSync(ctx.reportPath)) {
        try {
          cached = JSON.parse(fs.readFileSync(ctx.reportPath, "utf8"));
        } catch (error) {
          return { ok: false, error: String(error.message || error) };
        }
      }

      const fresh = analyzeImpact(worktree, analyzeOpts);
      const report = mergeCacheHint(cached, fresh, head);
      // The identity is recorded after the merge so a cache hint can never
      // supply or overwrite it.
      report.impact_identity = identity || null;
      report.impact_analyzer_version = IMPACT_ANALYZER_VERSION;
      const outPath =
        ctx.outPath || path.join(worktree, ".opencode", "impact", "latest.json");
      try {
        const root = path.resolve(worktree);
        // Caller-supplied outPath is not exempt: a relative or absolute path
        // still has to stay inside the worktree, including through symlinks.
        const resolvedOut = path.resolve(root, outPath);
        const boundary = validateContainedPath(root, resolvedOut, {
          allowMissing: true,
          rejectSymlinks: true,
        });
        if (boundary.ok) {
          fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
          const afterMkdir = validateContainedPath(root, resolvedOut, {
            allowMissing: true,
            rejectSymlinks: true,
          });
          if (afterMkdir.ok) {
            fs.writeFileSync(
              resolvedOut,
              JSON.stringify(report, null, 2) + "\n",
            );
          }
        }
      } catch {
        // optional persist
      }
      return {
        ok: !!report.ok,
        report,
        path: outPath,
        identity: identity || null,
        cache_hit: false,
        recomputed: true,
      };
    },
  };
}
