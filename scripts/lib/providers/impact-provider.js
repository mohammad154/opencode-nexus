/**
 * Impact provider interface. V4 backend is Nexus Impact Engine.
 * Graphify wrappers remain only as legacy fallbacks during migration tests.
 */
import fs from "fs";
import path from "path";
import { analyzeImpact } from "../impact/analyze.js";

export function createNexusImpactProvider() {
  return {
    mode: "nexus-impact",
    supported: true,
    capability: "impact-analysis",
    quality: "nexus-impact",
    analyze(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      if (ctx.report && typeof ctx.report === "object" && ctx.report.provider_validated === true) {
        return { ok: true, report: ctx.report, cache_hit: true };
      }
      if (ctx.reportPath && fs.existsSync(ctx.reportPath)) {
        try {
          const report = JSON.parse(fs.readFileSync(ctx.reportPath, "utf8"));
          return { ok: !!report.ok, report, path: ctx.reportPath };
        } catch (error) {
          return { ok: false, error: String(error.message || error) };
        }
      }
      const report = analyzeImpact(worktree, {
        base: ctx.base || "HEAD",
        change_class: ctx.change_class || ctx.changeClass,
      });
      const outPath =
        ctx.outPath || path.join(worktree, ".opencode", "impact", "latest.json");
      try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
      } catch {
        // optional persist
      }
      return { ok: !!report.ok, report, path: outPath };
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
