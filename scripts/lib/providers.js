/**
 * Provider registry — Phase 1 Lite / noop implementations.
 * Phase 2–3 swap implementations without changing the state machine.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

export function createNoopTelemetry() {
  return {
    emit(_event) {
      /* Phase 3 JSONL sink */
    },
  };
}

export function createLessonsMemory() {
  return {
    retrieve(worktree, _query = {}) {
      const lessons = path.join(
        worktree,
        ".opencode",
        "knowledge",
        "LESSONS.md",
      );
      if (!fs.existsSync(lessons)) return { entries: [], source: "none" };
      const txt = fs.readFileSync(lessons, "utf8");
      const tailLen = 2500;
      const slice = txt.length > tailLen ? txt.slice(-tailLen) : txt;
      return { entries: [slice], source: "lessons-tail" };
    },
  };
}

export function createLiteGraphProvider() {
  return {
    mode: "lite",
    build(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      const graphJson = path.join(
        worktree,
        ".opencode",
        "knowledge",
        "graph.json",
      );
      if (fs.existsSync(graphJson) && !ctx.force) {
        try {
          const g = JSON.parse(fs.readFileSync(graphJson, "utf8"));
          return {
            ok: true,
            path: graphJson,
            confidence: g.confidence ?? g.meta?.confidence ?? 0.75,
            snapshot: g,
          };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }
      const script = path.join(REPO_ROOT, "scripts", "nexus-graph.sh");
      if (!fs.existsSync(script)) {
        return {
          ok: fs.existsSync(graphJson),
          path: graphJson,
          confidence: 0.5,
          skipped: true,
        };
      }
      const r = spawnSync("bash", [script], {
        cwd: worktree,
        encoding: "utf8",
      });
      if (r.status !== 0 && !fs.existsSync(graphJson)) {
        return { ok: false, error: r.stderr || r.stdout || "graph failed" };
      }
      let confidence = 0.75;
      if (fs.existsSync(graphJson)) {
        try {
          const g = JSON.parse(fs.readFileSync(graphJson, "utf8"));
          confidence = g.confidence ?? g.meta?.confidence ?? 0.75;
        } catch {
          /* keep default */
        }
      }
      return { ok: true, path: graphJson, confidence, stdout: r.stdout };
    },
  };
}

export function createLiteBlastProvider() {
  return {
    mode: "lite",
    analyze(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      const outPath =
        ctx.outPath ||
        path.join(worktree, ".opencode", "knowledge", "blast", "latest.json");
      if (ctx.report && typeof ctx.report === "object") {
        const report = {
          uncertainties: [],
          dimensions: {},
          ...ctx.report,
          risk: ctx.report.risk || ctx.report.level || "UNKNOWN",
        };
        return { ok: true, report, path: ctx.outPath || null };
      }
      if (ctx.reportPath && fs.existsSync(ctx.reportPath)) {
        const report = JSON.parse(fs.readFileSync(ctx.reportPath, "utf8"));
        if (!report.uncertainties) report.uncertainties = [];
        if (!report.dimensions) report.dimensions = {};
        if (!report.risk) report.risk = report.level || "UNKNOWN";
        return { ok: true, report, path: ctx.reportPath };
      }
      const script = path.join(REPO_ROOT, "scripts", "nexus-blast.js");
      if (!fs.existsSync(script)) {
        return { ok: false, error: "nexus-blast.js not found" };
      }
      const args = [script];
      if (ctx.files?.length) args.push("--files", ctx.files.join(","));
      if (ctx.task != null) args.push("--task", String(ctx.task));
      if (ctx.mermaid) args.push("--mermaid");
      const r = spawnSync(process.execPath, args, {
        cwd: worktree,
        encoding: "utf8",
      });
      if (fs.existsSync(outPath)) {
        const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
        if (!report.uncertainties) report.uncertainties = [];
        if (!report.dimensions) report.dimensions = {};
        return { ok: true, report, path: outPath, stdout: r.stdout };
      }
      // Try parse stdout JSON
      try {
        const report = JSON.parse(r.stdout || "{}");
        if (!report.uncertainties) report.uncertainties = [];
        if (!report.dimensions) report.dimensions = {};
        if (!report.risk) report.risk = report.level || "UNKNOWN";
        return { ok: r.status === 0, report, stdout: r.stdout };
      } catch {
        return { ok: false, error: r.stderr || r.stdout || "blast failed" };
      }
    },
  };
}

export function createEditValidator() {
  return {
    validate(_patch) {
      return { ok: true, mode: "noop" };
    },
  };
}

export function getGraphProvider(
  mode = process.env.NEXUS_GRAPH_MODE || "lite",
) {
  if (mode === "lite") return createLiteGraphProvider();
  // Phase 2: enhanced / ide
  return createLiteGraphProvider();
}

export function getBlastProvider(
  mode = process.env.NEXUS_BLAST_MODE || "lite",
) {
  if (mode === "lite") return createLiteBlastProvider();
  return createLiteBlastProvider();
}

export function getEditValidator() {
  return createEditValidator();
}

export function createDefaultProviders() {
  return {
    graphProvider: getGraphProvider(),
    blastProvider: getBlastProvider(),
    telemetry: createNoopTelemetry(),
    memory: createLessonsMemory(),
    editValidator: getEditValidator(),
  };
}
