/**
 * Provider registry — deterministic Lite providers and host measurement hooks.
 * Provider implementations can evolve without changing the state machine.
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SUPPORTED_PROVIDER_MODE = "lite";
const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const GRAPH_PROVIDER_METADATA = {
  capability: "dependency-graph",
  quality: "lite-heuristic",
};

const BLAST_PROVIDER_METADATA = {
  capability: "blast-radius",
  quality: "lite-heuristic",
};

const EDIT_VALIDATOR_METADATA = {
  capability: "scope-and-obvious-safety",
  quality: "deterministic",
};

const DUAL_REVIEW_CLASSES = new Set([
  "public-api",
  "authentication-security",
  "database-migration",
  "high-blast",
]);

// These are the hard defaults represented by scripts/nexus-estimate-calls.js:
// docs/direct work is implementer-only, normal units use implementer + one
// unified reviewer, and strict/high-risk units use implementer + two reviewers.
const PROFILE_CALLS_PER_UNIT = Object.freeze({
  fast: { normal: 2, documentation: 1, direct: 1, dual: 3 },
  balanced: { normal: 2, documentation: 1, direct: 1, dual: 3 },
  strict: { normal: 3, documentation: 1, direct: 1, dual: 3 },
});

const GRAPH_GENERATOR_VERSION = "3.0";
const GRAPH_EXTRACTOR_VERSION = "3.0";
const GRAPH_QUALITY_RANK = Object.freeze({ PRECISE: 2, CONSERVATIVE: 1, UNSUPPORTED: 0 });

function normalizeMode(mode) {
  const normalized = String(mode ?? SUPPORTED_PROVIDER_MODE)
    .trim()
    .toLowerCase();
  return normalized || SUPPORTED_PROVIDER_MODE;
}

/**
 * Resolve the hard maximum number of agent calls for a run.
 *
 * The defaults intentionally mirror nexus-estimate-calls.js. Hosts may pass
 * a lower explicit max_calls, but cannot raise the profile-derived ceiling.
 */
export function getAgentCallBudget(options = {}) {
  const profile = String(options.profile || "balanced").trim().toLowerCase();
  const matrix = PROFILE_CALLS_PER_UNIT[profile] || PROFILE_CALLS_PER_UNIT.balanced;
  const changeClass = String(options.changeClass || options.change_class || "small-feature-with-tests")
    .trim()
    .toLowerCase();
  const executionMode = String(options.executionMode || options.execution_mode || "")
    .trim()
    .toLowerCase();
  const units = Math.max(1, Math.floor(Number(options.units) || 1));
  const kind = options.direct === true || executionMode === "direct"
    ? "direct"
    : changeClass === "documentation"
    ? "documentation"
    : DUAL_REVIEW_CLASSES.has(changeClass)
      ? "dual"
      : "normal";
  const derivedMax = matrix[kind] * units;
  const requestedMax = Number(options.maxCalls ?? options.max_calls);
  const maxCalls = Number.isFinite(requestedMax) && requestedMax >= 0
    ? Math.min(Math.floor(requestedMax), derivedMax)
    : derivedMax;
  return {
    profile: PROFILE_CALLS_PER_UNIT[profile] ? profile : "balanced",
    change_class: changeClass,
    execution_mode: executionMode || (options.direct === true ? "direct" : "delegated"),
    units,
    category: kind,
    max_calls: maxCalls,
    derived_max_calls: derivedMax,
    source: "workflow-profile-defaults",
  };
}

function unsupportedProviderResult(kind, mode) {
  const error = `Unsupported ${kind} provider mode "${mode}". Supported modes: ${SUPPORTED_PROVIDER_MODE}.`;
  return {
    ok: false,
    supported: false,
    mode,
    requested_mode: mode,
    capability: "unsupported",
    quality: "unavailable",
    supported_modes: [SUPPORTED_PROVIDER_MODE],
    error,
  };
}

export function createUnsupportedProvider(kind, mode) {
  const normalizedMode = normalizeMode(mode);
  const metadata = unsupportedProviderResult(kind, normalizedMode);
  const method = kind === "graph" ? "build" : "analyze";
  return {
    ...metadata,
    [method]() {
      return { ...metadata };
    },
  };
}

function providerResultMetadata(metadata, cacheHit = undefined) {
  const result = {
    supported: true,
    provider_mode: SUPPORTED_PROVIDER_MODE,
    provider_capability: metadata.capability,
    provider_quality: metadata.quality,
  };
  if (cacheHit !== undefined) result.cache_hit = cacheHit;
  return result;
}

function annotateLiteBlastReport(report) {
  const normalized = {
    uncertainties: [],
    dimensions: {},
    ...(report && typeof report === "object" ? report : {}),
  };
  const placeholders = new Set(
    Array.isArray(normalized.placeholder_fields)
      ? normalized.placeholder_fields
      : [],
  );
  for (const field of ["changed_symbols", "tests", "dimensions"]) {
    const value = normalized[field];
    if (
      (Array.isArray(value) && value.length === 0) ||
      (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
    ) {
      placeholders.add(field);
    }
  }
  return {
    ...normalized,
    analysis_quality: normalized.analysis_quality || "lite-heuristic",
    analysis_complete: normalized.analysis_complete ?? false,
    placeholder_fields: [...placeholders],
  };
}

export function createNoopTelemetry() {
  return {
    mode: "noop",
    supported: false,
    emit() {
      return { recorded: false, reason: "telemetry disabled" };
    },
  };
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeMetricLabel(value, maxLength = 160) {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function safeMetricRunId(value) {
  return typeof value === "string" && SAFE_RUN_ID_RE.test(value) ? value : null;
}

function numericMetric(value) {
  return finiteNonNegative(value) ? value : null;
}

function normalizeTokens(tokens) {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const out = {};
  for (const key of ["input", "output", "total", "cache_read", "cache_write"]) {
    const value = numericMetric(tokens[key]);
    if (value !== null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function tokenDataFromEvent(input) {
  if (input.tokens && typeof input.tokens === "object") return input.tokens;
  const aliases = {
    input: input.input_tokens,
    output: input.output_tokens,
    total: input.total_tokens,
    cache_read: input.cache_read_tokens,
    cache_write: input.cache_write_tokens,
  };
  return Object.values(aliases).some((value) => value !== undefined)
    ? aliases
    : null;
}

function sanitizeMetricEvent(event = {}) {
  const input = event && typeof event === "object" ? event : {};
  const out = {
    timestamp: safeMetricLabel(input.timestamp) || new Date().toISOString(),
    event:
      safeMetricLabel(input.event || input.type || "metric", 80) || "metric",
  };

  const runId = safeMetricRunId(input.run_id || input.runId);
  if (runId) out.run_id = runId;

  for (const key of ["step", "provider", "from", "to", "profile", "status"]) {
    const value = safeMetricLabel(input[key], 120);
    if (value) out[key] = value;
  }

  for (const key of ["duration_ms", "call_count", "cache_hits", "failures"]) {
    const value = numericMetric(input[key]);
    if (value !== null) out[key] = value;
  }

  if (typeof input.cache_hit === "boolean") out.cache_hit = input.cache_hit;

  const failureCode = safeMetricLabel(input.failure_code || input.error_code, 120);
  if (failureCode) out.failure_code = failureCode;

  const tokens = normalizeTokens(tokenDataFromEvent(input));
  if (tokens) out.tokens = tokens;

  const costUsd = numericMetric(input.cost_usd ?? input.costUsd);
  if (costUsd !== null) out.cost_usd = costUsd;

  return out;
}

function metricsPathFor({ worktree, runId, metricsPath }) {
  if (metricsPath) {
    return path.isAbsolute(metricsPath)
      ? metricsPath
      : path.resolve(worktree, metricsPath);
  }
  if (!runId || !SAFE_RUN_ID_RE.test(runId)) return null;
  const runDir = path.join(worktree, ".opencode", "runs", runId);
  // The CLI creates the run directory during init. Avoid creating metric files
  // for callers that only use the state machine as an in-memory library.
  if (!fs.existsSync(runDir)) return null;
  return path.join(runDir, "metrics.jsonl");
}

function addMetricTotals(totals, event) {
  for (const key of ["duration_ms", "call_count", "cache_hits", "failures"]) {
    if (finiteNonNegative(event[key])) totals[key] += event[key];
  }
  if (event.tokens) {
    totals.tokens = totals.tokens || {};
    for (const [key, value] of Object.entries(event.tokens)) {
      if (finiteNonNegative(value)) totals.tokens[key] = (totals.tokens[key] || 0) + value;
    }
  }
  if (finiteNonNegative(event.cost_usd)) {
    totals.cost_usd = (totals.cost_usd || 0) + event.cost_usd;
  }
}

/**
 * Small, secret-safe measurement hook. Unknown fields (including prompts,
 * messages, raw errors, and credentials) are deliberately dropped.
 *
 * The JSONL sink is enabled when a host supplies metricsPath, or for an
 * initialized run at .opencode/runs/<run_id>/metrics.jsonl. Other callers get
 * the same sanitized in-memory events without filesystem side effects.
 */
export function createMetricsTelemetry(options = {}) {
  const worktree = path.resolve(options.worktree || process.cwd());
  const enabled = options.enabled !== false;
  const budget = getAgentCallBudget(options);
  let acceptedCalls = 0;
  const events = [];
  const totals = {
    duration_ms: 0,
    call_count: 0,
    cache_hits: 0,
    failures: 0,
  };

  function emit(rawEvent = {}) {
    const event = sanitizeMetricEvent(rawEvent);
    events.push(event);
    addMetricTotals(totals, event);

    if (!enabled) return { recorded: false, event, reason: "telemetry disabled" };

    const destination = metricsPathFor({
      worktree,
      runId: event.run_id,
      metricsPath: options.metricsPath,
    });
    if (!destination) {
      return { recorded: false, event, reason: "metrics path unavailable" };
    }

    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.appendFileSync(destination, `${JSON.stringify(event)}\n`, "utf8");
      return { recorded: true, event, path: destination };
    } catch (error) {
      return {
        recorded: false,
        event,
        path: destination,
        reason: "metrics write failed",
        failure_code: safeMetricLabel(error?.code || "write_error", 80),
      };
    }
  }

  return {
    mode: "jsonl",
    supported: true,
    budget,
    emit,
    recordStep(data = {}) {
      let duration = numericMetric(data.duration_ms);
      if (duration === null) duration = numericMetric(data.durationMs);
      if (duration === null && data.started_at && data.ended_at) {
        const started = Date.parse(data.started_at);
        const ended = Date.parse(data.ended_at);
        if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
          duration = ended - started;
        }
      }
      return emit({ ...data, event: "step", duration_ms: duration ?? undefined });
    },
    recordCall(data = {}) {
      const requestedCalls = Number.isFinite(Number(data.call_count)) && Number(data.call_count) > 0
        ? Math.floor(Number(data.call_count))
        : 1;
      if (acceptedCalls + requestedCalls > budget.max_calls) {
        const failure = emit({
          ...data,
          event: "failure",
          status: "rejected",
          failure_code: "AGENT_CALL_BUDGET_EXCEEDED",
          failures: 1,
        });
        return {
          ...failure,
          accepted: false,
          budget_exceeded: true,
          budget,
          failure_code: failure.event.failure_code,
          requested_calls: requestedCalls,
          remaining_calls: Math.max(0, budget.max_calls - acceptedCalls),
        };
      }
      acceptedCalls += requestedCalls;
      const result = emit({
        ...data,
        event: "agent_call",
        call_count: requestedCalls,
        budget_remaining: budget.max_calls - acceptedCalls,
      });
      return {
        ...result,
        accepted: true,
        budget,
        requested_calls: requestedCalls,
        remaining_calls: Math.max(0, budget.max_calls - acceptedCalls),
      };
    },
    recordCacheHit(data = {}) {
      return emit({
        ...data,
        event: "cache",
        cache_hit: true,
        cache_hits: data.cache_hits ?? 1,
      });
    },
    recordFailure(data = {}) {
      return emit({
        ...data,
        event: "failure",
        failures: data.failures ?? 1,
      });
    },
    getEvents() {
      return events.map((event) => ({ ...event, tokens: event.tokens && { ...event.tokens } }));
    },
    getTotals() {
      return {
        ...totals,
        tokens: totals.tokens ? { ...totals.tokens } : undefined,
      };
    },
    getBudget() {
      return { ...budget, used_calls: acceptedCalls, remaining_calls: Math.max(0, budget.max_calls - acceptedCalls) };
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

function graphDigest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function graphSourceFingerprint(graph) {
  const records = (graph.nodes || [])
    .map((node) => ({
      path: String(node.path || node.id || "").replace(/\\/g, "/"),
      file_hash: node.file_hash || "UNREADABLE",
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return graphDigest(records.map((record) => `${record.path}\t${record.file_hash}`).join("\n"));
}

function graphStatusLines(worktree, outputDirectory) {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: worktree,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const outputRel = path.relative(worktree, outputDirectory).replace(/\\/g, "/");
  return String(result.stdout || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      if (!outputRel || outputRel === ".") return true;
      const statusPath = line.slice(3).trim().replace(/^"|"$/g, "");
      const candidates = statusPath.includes(" -> ")
        ? statusPath.split(" -> ").map((value) => value.trim())
        : [statusPath];
      return !candidates.some(
        (candidate) => candidate === outputRel || candidate.startsWith(`${outputRel}/`),
      );
    })
    .sort();
}

function graphWorkingTreeFingerprint(worktree, graph, sourceFingerprint) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  });
  const commit = head.status === 0 ? String(head.stdout || "").trim() || "unknown" : "unknown";
  const outputDirectory = path.resolve(worktree, graph.output_dir || ".opencode/knowledge");
  const status = graphStatusLines(worktree, outputDirectory);
  if (status === null) return null;
  return graphDigest(JSON.stringify({
    head_commit: commit,
    source_fingerprint: sourceFingerprint,
    status,
  }));
}

function graphConfidence(graph, quality) {
  const requested = Number(graph?.confidence ?? graph?.meta?.confidence);
  const base = Number.isFinite(requested) && requested >= 0 ? requested : 0.75;
  const ceiling = { PRECISE: 0.75, CONSERVATIVE: 0.5, UNSUPPORTED: 0.2 }[quality] ?? 0;
  return Math.min(base, ceiling);
}

function validateGraphCache(worktree, graph) {
  const issues = [];
  if (!graph || typeof graph !== "object") issues.push("graph is not an object");
  const freshness = graph?.freshness;
  const extractor = graph?.extractor;
  if (!freshness || !extractor) issues.push("freshness metadata is missing");
  if (graph?.generator_version !== GRAPH_GENERATOR_VERSION || freshness?.generator_version !== GRAPH_GENERATOR_VERSION) {
    issues.push("generator version is stale");
  }
  if (extractor?.version !== GRAPH_EXTRACTOR_VERSION) issues.push("extractor version is stale");
  const quality = graph?.extractor_quality || extractor?.quality;
  if (!(quality in GRAPH_QUALITY_RANK)) issues.push(`graph quality is ${quality || "unknown"}`);

  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" });
  const currentHead = head.status === 0 ? String(head.stdout || "").trim() || "unknown" : "unknown";
  if (freshness?.head_commit !== currentHead) issues.push("HEAD commit changed");

  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const sourceFingerprint = graphSourceFingerprint(graph || {});
  if (freshness?.source_fingerprint !== sourceFingerprint || graph?.source_fingerprint !== sourceFingerprint) {
    issues.push("source fingerprint is inconsistent");
  }
  for (const node of nodes) {
    const relative = String(node.path || node.id || "").replace(/\\/g, "/");
    if (!relative || !node.file_hash) {
      issues.push(`file hash missing for ${relative || "unknown node"}`);
      continue;
    }
    const absolute = path.resolve(worktree, relative);
    if (!absolute.startsWith(`${path.resolve(worktree)}${path.sep}`) || !fs.existsSync(absolute)) {
      issues.push(`indexed file missing: ${relative}`);
      continue;
    }
    const currentHash = graphDigest(fs.readFileSync(absolute));
    if (currentHash !== node.file_hash) issues.push(`file changed: ${relative}`);
  }
  const workingTreeFingerprint = graphWorkingTreeFingerprint(worktree, graph || {}, sourceFingerprint);
  if (workingTreeFingerprint === null || freshness?.working_tree_fingerprint !== workingTreeFingerprint) {
    issues.push("working-tree fingerprint changed");
  }
  return {
    ok: issues.length === 0,
    issues,
    quality: quality || "UNKNOWN",
    trusted: quality === "PRECISE",
  };
}

function untrustedGraphResult(graphJson, graph, trust, extra = {}) {
  return {
    ok: false,
    ...providerResultMetadata(GRAPH_PROVIDER_METADATA, false),
    provider_quality: "unknown",
    quality: "UNKNOWN",
    path: graphJson,
    snapshot: graph,
    stale: true,
    trust_issues: trust.issues,
    error: `Graph cache is not trusted: ${trust.issues.join("; ")}`,
    ...extra,
  };
}

export function createLiteGraphProvider() {
  return {
    mode: "lite",
    supported: true,
    ...GRAPH_PROVIDER_METADATA,
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
          const trust = validateGraphCache(worktree, g);
          if (!trust.ok) return untrustedGraphResult(graphJson, g, trust);
          return {
            ok: true,
            ...providerResultMetadata(GRAPH_PROVIDER_METADATA, true),
            path: graphJson,
            quality: trust.quality,
            trusted: trust.trusted,
            stale: false,
            confidence: graphConfidence(g, trust.quality),
            snapshot: g,
          };
        } catch (e) {
          return untrustedGraphResult(
            graphJson,
            null,
            { issues: [`graph JSON is invalid: ${e.message || String(e)}`] },
          );
        }
      }
      const script = path.join(REPO_ROOT, "scripts", "nexus-graph.sh");
      if (!fs.existsSync(script)) {
        return {
          ok: false,
          ...providerResultMetadata(GRAPH_PROVIDER_METADATA, false),
          provider_quality: "unknown",
          quality: "UNKNOWN",
          stale: true,
          path: graphJson,
          skipped: true,
          error: "graph builder is unavailable; cache trust cannot be verified",
        };
      }
      const r = spawnSync("bash", [script], {
        cwd: worktree,
        encoding: "utf8",
      });
      if (r.status !== 0 && !fs.existsSync(graphJson)) {
        return {
          ok: false,
          ...providerResultMetadata(GRAPH_PROVIDER_METADATA, false),
          error: r.stderr || r.stdout || "graph failed",
        };
      }
      let confidence = 0.75;
      if (fs.existsSync(graphJson)) {
        try {
          const g = JSON.parse(fs.readFileSync(graphJson, "utf8"));
          const trust = validateGraphCache(worktree, g);
          if (!trust.ok) {
            return untrustedGraphResult(graphJson, g, trust, {
              rebuild_attempted: true,
              stdout: r.stdout,
            });
          }
          confidence = graphConfidence(g, trust.quality);
          return {
            ok: true,
            ...providerResultMetadata(GRAPH_PROVIDER_METADATA, false),
            path: graphJson,
            quality: trust.quality,
            trusted: trust.trusted,
            stale: false,
            confidence,
            snapshot: g,
            stdout: r.stdout,
          };
        } catch {
          /* fall through to the untrusted failure below */
          return untrustedGraphResult(
            graphJson,
            null,
            { issues: ["rebuilt graph JSON is invalid"] },
            { rebuild_attempted: true, stdout: r.stdout },
          );
      }
      }
      return {
        ok: false,
        ...providerResultMetadata(GRAPH_PROVIDER_METADATA, false),
        provider_quality: "unknown",
        quality: "UNKNOWN",
        stale: true,
        path: graphJson,
        error: "graph builder produced no graph snapshot",
        stdout: r.stdout,
      };
    },
  };
}

export function createLiteBlastProvider() {
  return {
    mode: "lite",
    supported: true,
    ...BLAST_PROVIDER_METADATA,
    analyze(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      const outPath =
        ctx.outPath ||
        path.join(worktree, ".opencode", "knowledge", "blast", "latest.json");
      // Inline reports are authoritative only when already provider-sealed.
      if (ctx.report && typeof ctx.report === "object") {
        if (
          ctx.report.provider_validated === true &&
          ctx.report.artifact_digest
        ) {
          const report = annotateLiteBlastReport({
            uncertainties: [],
            dimensions: {},
            ...ctx.report,
            risk: ctx.report.risk || ctx.report.level || "UNKNOWN",
          });
          return {
            ok: true,
            ...providerResultMetadata(BLAST_PROVIDER_METADATA, true),
            report,
            path: ctx.outPath || null,
          };
        }
        // Ignore fabricated inline trust labels — fall through to artifact/script.
      }
      if (ctx.reportPath && fs.existsSync(ctx.reportPath)) {
        const report = annotateLiteBlastReport(
          JSON.parse(fs.readFileSync(ctx.reportPath, "utf8")),
        );
        if (!report.uncertainties) report.uncertainties = [];
        if (!report.dimensions) report.dimensions = {};
        if (!report.risk) report.risk = report.level || "UNKNOWN";
        return {
          ok: true,
          ...providerResultMetadata(BLAST_PROVIDER_METADATA, true),
          report,
          path: ctx.reportPath,
        };
      }
      const script = path.join(REPO_ROOT, "scripts", "nexus-blast.js");
      if (!fs.existsSync(script)) {
        return {
          ok: false,
          ...providerResultMetadata(BLAST_PROVIDER_METADATA, false),
          error: "nexus-blast.js not found",
        };
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
        const report = annotateLiteBlastReport(
          JSON.parse(fs.readFileSync(outPath, "utf8")),
        );
        if (!report.uncertainties) report.uncertainties = [];
        if (!report.dimensions) report.dimensions = {};
        return {
          ok: true,
          ...providerResultMetadata(BLAST_PROVIDER_METADATA, false),
          report,
          path: outPath,
          stdout: r.stdout,
        };
      }
      // Try parse stdout JSON
      try {
        const report = annotateLiteBlastReport(JSON.parse(r.stdout || "{}"));
        if (!report.uncertainties) report.uncertainties = [];
        if (!report.dimensions) report.dimensions = {};
        if (!report.risk) report.risk = report.level || "UNKNOWN";
        return {
          ok: r.status === 0,
          ...providerResultMetadata(BLAST_PROVIDER_METADATA, false),
          report,
          stdout: r.stdout,
        };
      } catch {
        return {
          ok: false,
          ...providerResultMetadata(BLAST_PROVIDER_METADATA, false),
          error: r.stderr || r.stdout || "blast failed",
        };
      }
    },
  };
}

function normalizePathValue(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.includes("../") ||
    normalized === ".."
  ) {
    return null;
  }
  return normalized;
}

function collectFileValues(value, out = []) {
  if (typeof value === "string") {
    const normalized = normalizePathValue(value);
    if (normalized) out.push(normalized);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileValues(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    collectFileValues(value.path || value.file || value.filename, out);
  }
  return out;
}

function collectRawFileValues(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRawFileValues(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    collectRawFileValues(value.path || value.file || value.filename, out);
  }
  return out;
}

function normalizedFileValues(value) {
  const raw = collectRawFileValues(value, []);
  return {
    files: raw.map(normalizePathValue).filter(Boolean),
    invalid: raw.filter((item) => !normalizePathValue(item)),
  };
}

function filesFromDiff(diff) {
  if (typeof diff !== "string" || diff.length === 0) {
    return { files: [], invalid: [] };
  }
  const files = [];
  const invalid = [];
  for (const line of diff.split("\n")) {
    let match = line.match(/^diff --git a\/.* b\/(.+)$/);
    if (!match) match = line.match(/^\+\+\+ b\/(.+)$/);
    if (!match || match[1] === "/dev/null") continue;
    const raw = match[1].trim();
    const normalized = normalizePathValue(raw);
    if (normalized) files.push(normalized);
    else invalid.push(raw);
  }
  return {
    files: [...new Set(files)],
    invalid: [...new Set(invalid)],
  };
}

function scopeMatches(scope, file) {
  if (scope === "*") return true;
  if (scope.endsWith("/")) return file.startsWith(scope);
  if (!scope.includes("*")) return scope === file;
  const pattern = `^${scope
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")}$`;
  return new RegExp(pattern).test(file);
}

const UNSAFE_DIFF_PATTERNS = [
  {
    code: "destructive-shell-command",
    pattern: /\b(?:rm\s+-rf|git\s+(?:reset\s+--hard|clean\s+-fd|checkout\s+--|restore\s+--source))\b/i,
  },
  {
    code: "privileged-command",
    pattern: /(?:^|[;&|]\s*)sudo\s+/i,
  },
  {
    code: "remote-script-execution",
    pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/i,
  },
  {
    code: "filesystem-format-command",
    pattern: /\b(?:mkfs(?:\.[\w-]+)?|dd\s+if=)\b/i,
  },
];

function unsafeAddedLines(diff) {
  if (typeof diff !== "string" || diff.length === 0) return [];
  const findings = [];
  const added = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  for (const line of added) {
    for (const entry of UNSAFE_DIFF_PATTERNS) {
      if (entry.pattern.test(line)) {
        findings.push({ code: entry.code });
      }
    }
  }
  return findings;
}

function declaredScopeValue(patch, options) {
  const value =
    options.declared_scope ??
    options.declaredScope ??
    patch?.declared_scope ??
    patch?.declaredScope ??
    patch?.scope;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value.files || value.paths || value;
  }
  return value;
}

/**
 * Deterministic edit validation. A complete result has validated === true;
 * missing scope or diff content is explicitly incomplete and must not be
 * presented to callers as a successful safety validation.
 */
export function createEditValidator() {
  return {
    mode: "deterministic",
    supported: true,
    ...EDIT_VALIDATOR_METADATA,
    validate(patch = {}, options = {}) {
      const source = typeof patch === "string" ? patch : patch || {};
      const diff =
        typeof source === "string"
          ? source
          : source.diff || source.patch || source.unified_diff || null;
      const changedInput =
        typeof source === "string"
          ? []
          : source.changed_files ||
            source.files_changed ||
            source.changedFiles ||
            source.changedPaths ||
            source.files;
      const normalizedChanged = normalizedFileValues(changedInput);
      const diffFiles = filesFromDiff(diff);
      const changedFiles = [
        ...new Set(normalizedChanged.files.concat(diffFiles.files)),
      ];
      const invalidChangedFiles = [
        ...new Set(normalizedChanged.invalid.concat(diffFiles.invalid)),
      ];
      const normalizedScope = normalizedFileValues(
        declaredScopeValue(typeof source === "string" ? {} : source, options),
      );
      const declaredScope = [...new Set(normalizedScope.files)];
      const invalidDeclaredScope = normalizedScope.invalid;

      if (declaredScope.length === 0 || invalidDeclaredScope.length > 0) {
        return {
          ok: false,
          validated: false,
          mode: "deterministic",
          error:
            declaredScope.length === 0
              ? "declared scope is required"
              : "declared scope contains invalid paths",
          changed_files: changedFiles,
          invalid_changed_files: invalidChangedFiles,
          invalid_declared_scope: invalidDeclaredScope,
          checks: { scope: "not_run", safety: "not_run" },
        };
      }
      if (changedFiles.length === 0) {
        return {
          ok: false,
          validated: false,
          mode: "deterministic",
          error: "changed files could not be determined",
          declared_scope: declaredScope,
          invalid_changed_files: invalidChangedFiles,
          invalid_declared_scope: invalidDeclaredScope,
          checks: { scope: "not_run", safety: "not_run" },
        };
      }

      const outOfScope = changedFiles.filter(
        (file) => !declaredScope.some((scope) => scopeMatches(scope, file)),
      );
      if (invalidChangedFiles.length > 0) {
        outOfScope.push(...invalidChangedFiles);
      }
      const unsafe = unsafeAddedLines(diff);
      const safetyAvailable = typeof diff === "string" && diff.length > 0;
      const result = {
        ok:
          outOfScope.length === 0 &&
          invalidDeclaredScope.length === 0 &&
          unsafe.length === 0,
        validated: safetyAvailable,
        mode: "deterministic",
        declared_scope: declaredScope,
        changed_files: changedFiles,
        invalid_changed_files: invalidChangedFiles,
        invalid_declared_scope: invalidDeclaredScope,
        out_of_scope: outOfScope,
        unsafe_findings: unsafe,
        checks: {
          scope: outOfScope.length === 0 ? "passed" : "failed",
          safety: safetyAvailable
            ? unsafe.length === 0
              ? "passed"
              : "failed"
            : "not_available",
        },
      };
      if (!safetyAvailable) {
        result.ok = false;
        result.reason = "diff content unavailable; unsafe-diff checks were not performed";
      }
      return result;
    },
  };
}

export function getGraphProvider(
  mode = process.env.NEXUS_GRAPH_MODE || "lite",
) {
  const normalizedMode = normalizeMode(mode);
  if (normalizedMode === SUPPORTED_PROVIDER_MODE) return createLiteGraphProvider();
  return createUnsupportedProvider("graph", normalizedMode);
}

export function getBlastProvider(
  mode = process.env.NEXUS_BLAST_MODE || "lite",
) {
  const normalizedMode = normalizeMode(mode);
  if (normalizedMode === SUPPORTED_PROVIDER_MODE) return createLiteBlastProvider();
  return createUnsupportedProvider("blast", normalizedMode);
}

export function getEditValidator() {
  return createEditValidator();
}

export function createDefaultProviders(options = {}) {
  const worktree = options.worktree || process.env.NEXUS_WORKTREE || process.cwd();
  return {
    graphProvider: getGraphProvider(),
    blastProvider: getBlastProvider(),
    telemetry:
      options.telemetry ||
      createMetricsTelemetry({
        worktree,
        metricsPath: options.metricsPath || process.env.NEXUS_METRICS_PATH,
        profile: options.profile || process.env.NEXUS_PROFILE,
        changeClass: options.changeClass || process.env.NEXUS_CHANGE_CLASS,
        executionMode:
          options.executionMode ||
          options.execution_mode ||
          process.env.NEXUS_EXECUTION_MODE,
        units: options.units || process.env.NEXUS_EXECUTION_UNITS,
        maxCalls: options.maxCalls || process.env.NEXUS_MAX_AGENT_CALLS,
      }),
    memory: createLessonsMemory(),
    editValidator: getEditValidator(),
  };
}
