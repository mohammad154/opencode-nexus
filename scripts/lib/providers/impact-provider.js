/**
 * Impact provider interface. V4 backend is Nexus Impact Engine.
 * Graphify wrappers remain only as legacy fallbacks during migration tests.
 *
 * Sealed digests are integrity/audit markers only — never authenticity.
 * Safety-critical callers must always recompute via analyzeImpact.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { analyzeImpact } from "../impact/analyze.js";

function gitHead(worktree) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return String(r.stdout || "").trim() || null;
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
    analyze(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      const head = gitHead(worktree);

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
      const outPath =
        ctx.outPath || path.join(worktree, ".opencode", "impact", "latest.json");
      try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
      } catch {
        // optional persist
      }
      return {
        ok: !!report.ok,
        report,
        path: outPath,
        cache_hit: false,
        recomputed: true,
      };
    },
  };
}

/** @deprecated Graphify-era dual providers — bridge until tests fully migrate */
export function createLegacyGraphBlastImpactBridge({ graphProvider, blastProvider }) {
  return {
    mode: "legacy-bridge",
    supported: true,
    capability: "impact-analysis",
    quality: "graphify-bridge",
    analyze(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      const graph = graphProvider?.build?.({ worktree, ...ctx }) || {};
      const blast = blastProvider?.analyze?.({ worktree, ...ctx }) || {};
      const report = blast.report || blast;
      return {
        ok: graph.ok !== false && blast.ok !== false,
        report: {
          schema_version: "1.0",
          provider: "legacy-bridge",
          ...report,
          confidence: report.confidence ?? graph.confidence ?? 0.5,
          risk: report.risk || report.level || "UNKNOWN",
          graph,
        },
      };
    },
  };
}
