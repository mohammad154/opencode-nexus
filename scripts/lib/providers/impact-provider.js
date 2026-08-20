/**
 * Impact provider interface. V4 backend is Nexus Impact Engine.
 * Graphify wrappers remain only as legacy fallbacks during migration tests.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { analyzeImpact } from "../impact/analyze.js";
import { verifySealedArtifact } from "../artifact-seal.js";

function gitHead(worktree) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return String(r.stdout || "").trim() || null;
}

function validateCachedReport(cached, fresh, head) {
  if (!cached || typeof cached !== "object") return fresh;
  if (cached.worktree_head && head && cached.worktree_head !== head) {
    return { ...fresh, cache_rejected: "stale_head", trusted: false };
  }
  if (
    cached.provider_validated === true &&
    cached.artifact_digest &&
    !verifySealedArtifact(cached)
  ) {
    return { ...fresh, cache_rejected: "bad_digest", trusted: false };
  }
  const merged = { ...fresh };
  if (cached.phase === "pre" && fresh.phase === "post") {
    merged.pre_impact_resolved = true;
  }
  if (cached.risk && fresh.risk && cached.risk !== fresh.risk) {
    merged.risk_drift = { from: cached.risk, to: fresh.risk };
    if (String(fresh.risk).toUpperCase() > String(cached.risk).toUpperCase()) {
      merged.trusted = false;
    }
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
      if (
        ctx.report &&
        typeof ctx.report === "object" &&
        ctx.report.provider_validated === true &&
        verifySealedArtifact(ctx.report)
      ) {
        if (head && ctx.report.worktree_head && ctx.report.worktree_head !== head) {
          return {
            ok: false,
            error: "sealed impact stale — worktree HEAD moved",
            report: { ...ctx.report, stale: true, trusted: false },
          };
        }
        return { ok: true, report: ctx.report, cache_hit: true };
      }

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
      const report = validateCachedReport(cached, fresh, head);
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
        cache_hit: !!cached,
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
