/**
 * Provider registry — Graphify-backed providers and host measurement hooks.
 * Provider implementations can evolve without changing the state machine.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import {
  prepareGraphifyGraph,
  resolveGraphifyGraphPath,
  resolveGraphifyOut,
} from "./graphify.js";
import { createNexusImpactProvider } from "./providers/impact-provider.js";
import { createVerificationProvider } from "./providers/verification-provider.js";
import { createMemoryProvider } from "./providers/memory-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SUPPORTED_PROVIDER_MODE = "nexus-impact";
const LEGACY_GRAPHIFY_MODE = "graphify";
const COMPAT_PROVIDER_MODE = "lite";
const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const GRAPH_PROVIDER_METADATA = {
  capability: "dependency-graph",
  quality: "graphify",
};

const BLAST_PROVIDER_METADATA = {
  capability: "blast-radius",
  quality: "graphify",
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

function annotateGraphifyBlastReport(report) {
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
    analysis_quality: normalized.analysis_quality || "UNKNOWN",
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
  // V4: prefer .opencode memory; legacy graphify-out remains read-only fallback.
  return createMemoryProvider();
}

function graphifyGraphResult(snapshot) {
  const trusted = snapshot?.ok === true && snapshot?.status === "FRESH";
  return {
    ok: trusted,
    ...providerResultMetadata(GRAPH_PROVIDER_METADATA, false),
    provider: "graphify",
    graph_provider: "graphify",
    path: snapshot?.path || null,
    graph_path: snapshot?.path || null,
    graphify_out: snapshot?.out_directory || null,
    snapshot: snapshot?.graph || null,
    freshness: snapshot?.freshness || {
      valid: false,
      status: snapshot?.status || "UNKNOWN",
      reasons: snapshot?.issues || ["Graphify graph was not validated"],
    },
    stale: !trusted,
    fresh: trusted,
    trusted,
    quality: trusted ? "PRECISE" : "UNKNOWN",
    confidence: trusted ? 1 : 0,
    trust_issues: snapshot?.issues || [],
    error: trusted ? undefined : (snapshot?.issues || ["Graphify graph is not trusted"]).join("; "),
    refresh: snapshot?.refresh || null,
  };
}

export function createGraphifyGraphProvider() {
  return {
    mode: "graphify",
    supported: true,
    ...GRAPH_PROVIDER_METADATA,
    build(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      // Trusted workflow decisions bind ONLY to the canonical Graphify output
      // for this worktree. A caller-supplied custom graph.json path is never
      // accepted here, so a foreign graph cannot be provider-sealed and satisfy
      // safety gates. Custom paths remain available for inspection tooling.
      const graphPath = resolveGraphifyGraphPath(worktree, ctx.graphifyOut);
      const requestedPath =
        ctx.path && String(ctx.path).endsWith("graph.json")
          ? path.resolve(
              path.isAbsolute(String(ctx.path))
                ? String(ctx.path)
                : path.resolve(worktree, String(ctx.path)),
            )
          : null;
      if (requestedPath && requestedPath !== graphPath) {
        return {
          ok: false,
          ...providerResultMetadata(GRAPH_PROVIDER_METADATA, false),
          provider: "graphify",
          graph_provider: "graphify",
          path: requestedPath,
          graph_path: requestedPath,
          canonical: false,
          stale: true,
          fresh: false,
          trusted: false,
          quality: "UNKNOWN",
          confidence: 0,
          trust_issues: [
            `custom graph path rejected for trusted decisions: ${requestedPath} (canonical is ${graphPath})`,
          ],
          error: `custom graph path rejected for trusted decisions: ${requestedPath}`,
        };
      }
      const snapshot = prepareGraphifyGraph({
        worktree,
        graphPath,
        force: !!ctx.force,
        command: ctx.graphifyCommand || "graphify",
        env: ctx.graphifyEnv || process.env,
      });
      return graphifyGraphResult(snapshot);
    },
  };
}

// Existing callers may still request the old provider mode name. It is only a
// compatibility alias; both implementations now use Graphify.
export function createLiteGraphProvider() {
  return createGraphifyGraphProvider();
}

function readBlastReport(reportPath) {
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
}

function currentGitHead(worktree) {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree,
      encoding: "utf8",
    });
    return r.status === 0 ? String(r.stdout || "").trim() || null : null;
  } catch {
    return null;
  }
}

function trustedGraphifyBlastReport(report, { worktree } = {}) {
  const baseTrust = Boolean(
    report &&
    report.graph_provider === "graphify" &&
    report.analysis_quality === "PRECISE" &&
    report.graph_quality === "PRECISE" &&
    report.graph_freshness?.valid === true &&
    report.analysis_complete !== false,
  );
  if (!baseTrust) return false;
  // Provenance: when we can determine the current HEAD, the report's freshness
  // evidence must have been computed against that same HEAD. This prevents a
  // supplied/stale PRECISE-looking report from being trusted for a different
  // repository state.
  if (worktree) {
    const head = currentGitHead(worktree);
    const reportHead =
      report.graph_freshness?.current_head ||
      report.graph_freshness?.built_at_commit ||
      report.worktree_head ||
      null;
    if (head && reportHead && reportHead !== head) return false;
  }
  return true;
}

function normalizeUntrustedBlastReport(report, reason) {
  const normalized = annotateGraphifyBlastReport({
    uncertainties: [],
    dimensions: {},
    ...(report && typeof report === "object" ? report : {}),
    risk: "UNKNOWN",
    level: "UNKNOWN",
    computed_risk: "UNKNOWN",
    analysis_quality: "UNKNOWN",
    graph_quality: "UNKNOWN",
    analysis_complete: false,
    graph_provider: "graphify",
  });
  normalized.uncertainties = [
    ...new Set([
      ...(Array.isArray(normalized.uncertainties) ? normalized.uncertainties : []),
      reason,
    ]),
  ];
  return normalized;
}

export function createGraphifyBlastProvider() {
  return {
    mode: "graphify",
    supported: true,
    ...BLAST_PROVIDER_METADATA,
    analyze(ctx = {}) {
      const worktree = ctx.worktree || process.cwd();
      const outPath =
        ctx.outPath ||
        path.join(worktree, ".opencode", "blast", "latest.json");
      const reportPath = ctx.reportPath
        ? path.isAbsolute(ctx.reportPath)
          ? ctx.reportPath
          : path.resolve(worktree, ctx.reportPath)
        : null;
      // Inline reports are authoritative only when already provider-sealed.
      if (ctx.report && typeof ctx.report === "object") {
        if (
          ctx.report.provider_validated === true &&
          ctx.report.artifact_digest
        ) {
          const report = annotateGraphifyBlastReport({
            uncertainties: [],
            dimensions: {},
            ...ctx.report,
            risk: ctx.report.risk || ctx.report.level || "UNKNOWN",
          });
          const trusted = trustedGraphifyBlastReport(report, { worktree });
          return {
            ok: true,
            ...providerResultMetadata(BLAST_PROVIDER_METADATA, true),
            report: trusted
              ? report
              : normalizeUntrustedBlastReport(
                report,
                "blast report lacks fresh, directed Graphify evidence",
              ),
            path: ctx.outPath || null,
          };
        }
        // Ignore fabricated inline trust labels — fall through to artifact/script.
      }
      if (reportPath && fs.existsSync(reportPath)) {
        const report = readBlastReport(reportPath);
        if (!report) {
          return {
            ok: false,
            ...providerResultMetadata(BLAST_PROVIDER_METADATA, true),
            error: `blast report is invalid: ${reportPath}`,
          };
        }
        const normalized = annotateGraphifyBlastReport(report);
        return {
          ok: true,
          ...providerResultMetadata(BLAST_PROVIDER_METADATA, true),
          report: trustedGraphifyBlastReport(normalized, { worktree })
            ? normalized
            : normalizeUntrustedBlastReport(
              normalized,
              "blast report lacks fresh, directed Graphify evidence for the current HEAD",
            ),
          path: reportPath,
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
      // Record the pre-existing output signature so a stale report from an
      // earlier invocation cannot be consumed if this generation fails.
      const priorStat = fs.existsSync(outPath) ? fs.statSync(outPath) : null;
      const priorSignature = priorStat
        ? `${priorStat.mtimeMs}:${priorStat.size}`
        : null;
      const r = spawnSync(process.execPath, args, {
        cwd: worktree,
        encoding: "utf8",
      });
      if (fs.existsSync(outPath)) {
        const freshStat = fs.statSync(outPath);
        const freshSignature = `${freshStat.mtimeMs}:${freshStat.size}`;
        const regenerated = freshSignature !== priorSignature;
        // Only trust the on-disk report when THIS invocation both succeeded and
        // rewrote the file. A pre-existing report left behind by a failed run
        // must never satisfy a safety gate.
        if (r.status !== 0 || !regenerated) {
          return {
            ok: false,
            ...providerResultMetadata(BLAST_PROVIDER_METADATA, false),
            error:
              r.status !== 0
                ? `Graphify blast generation failed (exit ${r.status}); refusing stale report at ${outPath}`
                : `Graphify blast did not regenerate ${outPath}; refusing stale report`,
            stderr: r.stderr,
          };
        }
        const report = readBlastReport(outPath);
        if (!report) {
          return {
            ok: false,
            ...providerResultMetadata(BLAST_PROVIDER_METADATA, false),
            error: `blast report is invalid: ${outPath}`,
          };
        }
        return {
          ok: true,
          ...providerResultMetadata(BLAST_PROVIDER_METADATA, false),
          report: annotateGraphifyBlastReport(report),
          path: outPath,
          stdout: r.stdout,
        };
      }
      // Try parse stdout JSON
      try {
        const parsed = JSON.parse(r.stdout || "{}");
        const report = parsed?.risk || parsed?.level
          ? annotateGraphifyBlastReport(parsed)
          : normalizeUntrustedBlastReport(
            parsed,
            r.stderr || r.stdout || "Graphify blast refresh did not produce a report",
          );
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

export function createLiteBlastProvider() {
  return createGraphifyBlastProvider();
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
  mode = process.env.NEXUS_GRAPH_MODE || LEGACY_GRAPHIFY_MODE,
) {
  const normalizedMode = normalizeMode(mode);
  if (
    [LEGACY_GRAPHIFY_MODE, COMPAT_PROVIDER_MODE, SUPPORTED_PROVIDER_MODE].includes(
      normalizedMode,
    )
  ) {
    // V4 default evidence is impact; graphify remains available for legacy callers/tests.
    return createGraphifyGraphProvider();
  }
  return createUnsupportedProvider("graph", normalizedMode);
}

export function getBlastProvider(
  mode = process.env.NEXUS_BLAST_MODE || LEGACY_GRAPHIFY_MODE,
) {
  const normalizedMode = normalizeMode(mode);
  if (
    [LEGACY_GRAPHIFY_MODE, COMPAT_PROVIDER_MODE, SUPPORTED_PROVIDER_MODE].includes(
      normalizedMode,
    )
  ) {
    return createGraphifyBlastProvider();
  }
  return createUnsupportedProvider("blast", normalizedMode);
}

export function getEditValidator() {
  return createEditValidator();
}

export function createDefaultProviders(options = {}) {
  const worktree = options.worktree || process.env.NEXUS_WORKTREE || process.cwd();
  const impactProvider = createNexusImpactProvider();
  return {
    impactProvider,
    verificationProvider: createVerificationProvider(),
    // Legacy aliases — graph/blast map to impact for V3 callers during migration.
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

export {
  createNexusImpactProvider,
  createVerificationProvider,
  createMemoryProvider,
};
