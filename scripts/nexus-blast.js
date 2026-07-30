#!/usr/bin/env node
/**
 * nexus-blast.js — deterministic blast-radius analysis.
 *
 * A score is useful as a diagnostic, but it is only exposed as a trusted risk
 * when the graph is fresh, parser-backed, and has no unresolved local edges.
 * Missing, stale, conservative, or unsupported graph data is reported as
 * UNKNOWN instead of being silently collapsed into LOW.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";

const GRAPH_GENERATOR_VERSION = "3.0";
const REPORT_SCHEMA_VERSION = "1.1";

const root = (() => {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
})();

function normalizePath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

function digestBuffer(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestText(value) {
  return digestBuffer(Buffer.from(value, "utf8"));
}

function headCommit(repoRoot) {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function readGraph() {
  const graphPath = path.join(root, ".opencode", "knowledge", "graph.json");
  if (!fs.existsSync(graphPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(graphPath, "utf8"));
  } catch {
    return null;
  }
}

function graphOutputDirectory(graph, repoRoot) {
  if (!graph?.output_dir || graph.output_dir === ".") {
    return path.join(repoRoot, ".opencode", "knowledge");
  }
  return path.resolve(repoRoot, graph.output_dir);
}

function statusLines(repoRoot, outputDirectory) {
  let status = "";
  try {
    status = execSync("git status --porcelain --untracked-files=all", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }

  const outputRel = normalizePath(path.relative(repoRoot, outputDirectory));
  return status
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
        (candidate) =>
          candidate === outputRel || candidate.startsWith(`${outputRel}/`),
      );
    })
    .sort();
}

function sourceFingerprint(records) {
  const manifest = records
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((record) => `${record.path}\t${record.file_hash || "UNREADABLE"}`)
    .join("\n");
  return digestText(manifest);
}

function workingTreeFingerprint(commit, source, repoRoot, outputDirectory) {
  return digestText(JSON.stringify({
    head_commit: commit,
    source_fingerprint: source,
    status: statusLines(repoRoot, outputDirectory),
  }));
}

function currentFileHash(file) {
  try {
    return digestBuffer(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function graphSourceRecords(graph, repoRoot) {
  return (graph?.nodes || [])
    .map((node) => {
      const graphPath = normalizePath(node.path || node.id || "");
      const absolute = path.resolve(repoRoot, graphPath);
      const hash = currentFileHash(absolute);
      return {
        path: graphPath,
        file_hash: hash || (fs.existsSync(absolute) ? "UNREADABLE" : "MISSING"),
      };
    })
    .filter((record) => record.path);
}

function validateGraphFreshness(graph) {
  const reasons = [];
  const checks = {
    source_fingerprint_match: null,
    working_tree_fingerprint_match: null,
    commit_match: null,
    generator_match: null,
  };

  if (!graph || typeof graph !== "object") {
    return {
      valid: false,
      status: "MISSING",
      reasons: ["graph.json missing or invalid"],
      ...checks,
    };
  }

  const graphRoot = path.resolve(graph.root || root);
  if (graphRoot !== path.resolve(root)) {
    reasons.push(`graph root mismatch: ${graphRoot}`);
  }

  const repoRoot = graphRoot;
  const outputDirectory = graphOutputDirectory(graph, repoRoot);
  const currentCommit = headCommit(repoRoot);
  const generatedCommit = graph.generated_at_commit || graph.freshness?.head_commit;
  const generatedVersion = graph.generator_version || graph.freshness?.generator_version;
  const source = graph.source_fingerprint || graph.freshness?.source_fingerprint;
  const working = graph.working_tree_fingerprint || graph.freshness?.working_tree_fingerprint;

  checks.commit_match = Boolean(
    generatedCommit && generatedCommit !== "unknown" && currentCommit !== "unknown" && generatedCommit === currentCommit,
  );
  checks.generator_match = generatedVersion === GRAPH_GENERATOR_VERSION;
  if (!checks.commit_match) {
    reasons.push(
      `graph commit is stale or unknown (generated=${generatedCommit || "missing"}, current=${currentCommit})`,
    );
  }
  if (!checks.generator_match) {
    reasons.push(
      `graph generator version mismatch (generated=${generatedVersion || "missing"}, expected=${GRAPH_GENERATOR_VERSION})`,
    );
  }
  if (!source || source === "unknown") reasons.push("graph source fingerprint missing or unknown");
  if (!working || working === "unknown") reasons.push("graph working-tree fingerprint missing or unknown");

  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    reasons.push("graph nodes/edges are missing or invalid");
  }

  const records = graphSourceRecords(graph, repoRoot);
  const currentSource = sourceFingerprint(records);
  checks.source_fingerprint_match = source === currentSource;
  if (source && source !== "unknown" && !checks.source_fingerprint_match) {
    reasons.push("source fingerprint mismatch; one or more indexed files changed");
  }

  const currentWorking = workingTreeFingerprint(
    currentCommit,
    currentSource,
    repoRoot,
    outputDirectory,
  );
  checks.working_tree_fingerprint_match = working === currentWorking;
  if (working && working !== "unknown" && !checks.working_tree_fingerprint_match) {
    reasons.push("working-tree fingerprint mismatch; graph metadata is stale");
  }

  for (const node of graph.nodes || []) {
    if (!node.file_hash) {
      reasons.push(`node ${node.id || node.path || "unknown"} has no file hash`);
      break;
    }
  }

  const freshness = graph.freshness || {};
  for (const [field, value] of [
    ["head_commit", generatedCommit],
    ["generator_version", generatedVersion],
    ["source_fingerprint", source],
    ["working_tree_fingerprint", working],
  ]) {
    if (freshness[field] !== undefined && freshness[field] !== value) {
      reasons.push(`freshness.${field} disagrees with graph metadata`);
    }
  }

  return {
    valid: reasons.length === 0,
    status: reasons.length === 0 ? "FRESH" : "STALE",
    reasons: [...new Set(reasons)],
    generated_at_commit: generatedCommit || null,
    current_head: currentCommit,
    generator_version: generatedVersion || null,
    ...checks,
  };
}

function buildReverseIndex(graph) {
  const reverse = new Map();
  for (const edge of graph?.edges || []) {
    if (edge.external) continue;
    const target = normalizePath(edge.to || "");
    const source = normalizePath(edge.from || "");
    if (!target || !source) continue;
    if (!reverse.has(target)) reverse.set(target, []);
    reverse.get(target).push(source);
  }
  return reverse;
}

function gitBaseBranch() {
  try {
    const head = execSync(
      "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'",
      { encoding: "utf8" },
    ).trim();
    if (head) return head;
  } catch {
    /* ignore */
  }
  for (const branch of ["main", "master", "develop"]) {
    try {
      execSync(`git show-ref --verify --quiet refs/heads/${branch}`);
      return branch;
    } catch {
      /* ignore */
    }
  }
  return "main";
}

function changedFiles(base) {
  try {
    const output = execSync(
      `git diff --name-only ${base}...HEAD 2>/dev/null || git diff --name-only --cached 2>/dev/null || git diff --name-only 2>/dev/null`,
      { encoding: "utf8" },
    );
    return output
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)
      .map(normalizePath);
  } catch {
    return [];
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    base: null,
    files: null,
    mermaidOnly: false,
    jsonOnly: false,
    markdown: false,
    task: null,
    explain: null,
    depth: 2,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--base") options.base = args[++index];
    else if (argument === "--files") {
      options.files = (args[++index] || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (argument === "--mermaid") options.mermaidOnly = true;
    else if (argument === "--json") options.jsonOnly = true;
    else if (argument === "--markdown") options.markdown = true;
    else if (argument === "--task") options.task = args[++index];
    else if (argument === "--explain") options.explain = args[++index];
    else if (argument === "--depth") options.depth = parseInt(args[++index], 10) || 2;
  }
  return options;
}

function normalizeStartFiles(files) {
  return [...new Set((files || []).map((file) => {
    const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
    return normalizePath(path.relative(root, absolute));
  }))];
}

function graphAssessment(graph, startFiles = []) {
  const freshness = validateGraphFreshness(graph);
  const graphQuality = graph?.extractor_quality || graph?.extractor?.quality || "UNKNOWN";
  const inferredLocalEdges = (graph?.edges || []).filter(
    (edge) => edge.confidence === "INFERRED" && !edge.external,
  ).length;
  const qualityReasons = [];
  const graphNodes = new Map(
    (graph?.nodes || []).map((node) => [normalizePath(node.id || node.path || ""), node]),
  );
  const unsupportedTargets = startFiles.filter(
    (file) => graphNodes.get(file)?.analysis_quality !== "PRECISE",
  );
  const targetQuality = unsupportedTargets.length === 0
    ? "PRECISE"
    : unsupportedTargets.some(
      (file) => graphNodes.get(file)?.analysis_quality === "UNSUPPORTED",
    )
      ? "UNSUPPORTED"
      : "CONSERVATIVE";
  if (graphQuality !== "PRECISE") {
    qualityReasons.push(`graph extractor quality is ${graphQuality}; parser-backed precision is unavailable`);
  }
  if (inferredLocalEdges > 0) {
    qualityReasons.push(`${inferredLocalEdges} unresolved local graph edge(s) are INFERRED`);
  }
  if (unsupportedTargets.length > 0) {
    qualityReasons.push(
      `target file analysis is not PRECISE: ${unsupportedTargets.join(", ")}`,
    );
  }
  const trusted =
    freshness.valid &&
    graphQuality === "PRECISE" &&
    inferredLocalEdges === 0 &&
    unsupportedTargets.length === 0;
  return {
    freshness,
    graphQuality,
    inferredLocalEdges,
    trusted,
    analysisQuality: trusted
      ? graphQuality
      : (freshness.valid
        ? (unsupportedTargets.length > 0 ? targetQuality : graphQuality)
        : "UNKNOWN"),
    qualityReasons,
  };
}

function computeBlast(startFiles, graph, reverseIndex, maxDepth, assessment) {
  const visited = new Set();
  const queue = startFiles.map((file) => ({ file, depth: 0, chain: [file] }));
  const impacts = [];
  const edges = [];
  const uncertainties = [
    ...(assessment?.freshness?.reasons || []),
    ...(assessment?.qualityReasons || []),
    ...((graph?.uncertainties || []).slice(0, 10)),
  ];
  const graphNodes = new Set((graph?.nodes || []).map((node) => normalizePath(node.id || node.path || "")));

  if (!graph) uncertainties.push("graph.json missing — dependents may be incomplete");
  for (const file of startFiles) {
    if (graph && !graphNodes.has(file)) {
      uncertainties.push(`target file is not present in graph: ${file}`);
    }
  }

  let inferredEdges = 0;
  for (const edge of graph?.edges || []) {
    if (
      edge.confidence === "INFERRED" ||
      (typeof edge.confidence_score === "number" && edge.confidence_score < 1)
    ) inferredEdges += 1;
  }
  if (inferredEdges > 0) {
    uncertainties.push(
      `${inferredEdges} graph edge(s) are inferred; treat dependent coverage as incomplete`,
    );
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const visitKey = `${current.file}:${current.depth}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    if (current.depth > maxDepth) continue;

    let direct = [...(reverseIndex.get(current.file) || [])];
    if (direct.length === 0 && graph && assessment?.graphQuality !== "PRECISE") {
      const base = path.basename(current.file);
      for (const [target, fromList] of reverseIndex.entries()) {
        if (
          path.basename(target) === base ||
          target === current.file ||
          target.includes(path.basename(current.file, path.extname(current.file)))
        ) {
          for (const source of fromList) if (!direct.includes(source)) direct.push(source);
        }
      }
    }

    for (const dependent of direct) {
      if (current.chain.includes(dependent)) continue;
      const depth = current.depth + 1;
      edges.push({ from: current.file, to: dependent, depth });
      const impact = {
        file: dependent,
        depth,
        via: [...current.chain, dependent],
        direct: current.depth === 0,
      };
      if (!impacts.some((entry) => entry.file === dependent)) impacts.push(impact);
      if (depth < maxDepth) {
        queue.push({ file: dependent, depth, chain: [...current.chain, dependent] });
      }
    }
  }

  let score = 0;
  for (const impact of impacts) {
    score += impact.direct ? 3 : impact.depth === 1 ? 2 : 1;
  }
  let computedRisk = "LOW";
  if (score >= 15 || impacts.length >= 10) computedRisk = "HIGH";
  else if (score >= 5 || impacts.length >= 3) computedRisk = "MEDIUM";

  if (impacts.length === 0 && uncertainties.length > 0) {
    uncertainties.push(
      "no downstream dependents detected under the available graph — do not treat as proven safe",
    );
  }

  const trusted = Boolean(assessment?.trusted) && graphNodes.size > 0;
  const level = trusted ? computedRisk : "UNKNOWN";
  return {
    startFiles,
    impacts,
    edges,
    score,
    level,
    risk: level,
    computed_risk: computedRisk,
    analysis_quality: assessment?.analysisQuality || "UNKNOWN",
    graph_quality: assessment?.graphQuality || "UNKNOWN",
    graph_freshness: assessment?.freshness || {
      valid: false,
      status: "MISSING",
      reasons: ["graph.json missing or invalid"],
    },
    direct_dependents: impacts.filter((impact) => impact.direct).map((impact) => impact.file),
    uncertainties: [...new Set(uncertainties)],
  };
}

function unsupportedFields() {
  return {
    changed_symbols: "not extracted by the deterministic blast analyzer",
    tests: "not discovered by the deterministic blast analyzer",
    dimensions: "not computed by the deterministic blast analyzer",
  };
}

function compactReport(blast) {
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    risk: blast.risk || blast.level,
    level: blast.level,
    computed_risk: blast.computed_risk,
    score: blast.score,
    analysis_quality: blast.analysis_quality,
    graph_quality: blast.graph_quality,
    graph_freshness: blast.graph_freshness,
    direct_dependents: blast.direct_dependents || [],
    uncertainties: blast.uncertainties || [],
    unsupported_fields: unsupportedFields(),
    dimensions: {
      supported: false,
      reason: "not computed by the deterministic blast analyzer",
    },
    files: blast.startFiles,
    startFiles: blast.startFiles,
    impacts: blast.impacts,
    edges: blast.edges,
  };
}

function renderMermaid(blast) {
  const lines = ["```mermaid", "flowchart TD"];
  const ids = new Map();
  let counter = 0;
  const getId = (file) => {
    if (!ids.has(file)) {
      const safe = `n${counter++}_${path.basename(file).replace(/[^a-zA-Z0-9]/g, "_")}`;
      ids.set(file, safe);
    }
    return ids.get(file);
  };

  for (const file of blast.startFiles) {
    const id = getId(file);
    lines.push(`  ${id}[\"${path.basename(file)}<br/>${file}\"]`);
    lines.push(`  style ${id} fill:#ff6b6b,stroke:#c92a2a,color:#fff`);
  }
  for (const impact of blast.impacts) {
    const id = getId(impact.file);
    if (!blast.startFiles.includes(impact.file)) {
      lines.push(`  ${id}[\"${path.basename(impact.file)}\"]`);
      lines.push(
        impact.depth === 1
          ? `  style ${id} fill:#ffd43b,stroke:#e67700`
          : `  style ${id} fill:#ffe066,stroke:#f59f00`,
      );
    }
  }
  for (const edge of blast.edges) lines.push(`  ${getId(edge.from)} --> ${getId(edge.to)}`);
  lines.push("```");
  return lines.join("\n");
}

function renderMarkdown(blast, graph) {
  const markdown = [];
  markdown.push(
    `# Blast Radius – risk: **${blast.level}** (computed ${blast.computed_risk}, score ${blast.score})`,
  );
  markdown.push("");
  markdown.push(`Analysis quality: **${blast.analysis_quality}**`);
  markdown.push("");
  markdown.push(`Changed files (${blast.startFiles.length}):`);
  for (const file of blast.startFiles) markdown.push(`- \`${file}\``);
  markdown.push("");
  if (blast.uncertainties.length > 0) {
    markdown.push("## Uncertainties");
    for (const uncertainty of blast.uncertainties) markdown.push(`- ${uncertainty}`);
    markdown.push("");
  }
  if (blast.impacts.length === 0) {
    markdown.push(
      "**No downstream dependents detected** under the available graph. Do not treat this as proven isolation unless analysis quality is PRECISE and freshness is FRESH.",
    );
  } else {
    markdown.push(`**${blast.impacts.length} downstream file(s) may be affected**:`);
    markdown.push("");
    markdown.push("| File | Depth | Via |");
    markdown.push("|------|-------|-----|");
    for (const impact of blast.impacts.slice(0, 60)) {
      markdown.push(`| \`${impact.file}\` | ${impact.depth} | ${impact.via.join(" → ")} |`);
    }
  }
  markdown.push("");
  if (blast.level === "HIGH") {
    markdown.push("## Mermaid (blast radius diagram)");
    markdown.push("");
    markdown.push(renderMermaid(blast));
    markdown.push("");
  } else {
    markdown.push("_Mermaid omitted (use `--mermaid` or HIGH risk)._ ");
    markdown.push("");
  }
  markdown.push("## Implementer guidance");
  if (blast.level === "UNKNOWN") {
    markdown.push("- UNKNOWN risk: refresh/fix graph freshness or quality before relying on the score.");
  } else if (blast.level === "HIGH") {
    markdown.push("- HIGH risk: many callers. Update scope, run downstream tests, and consider splitting.");
  } else if (blast.level === "MEDIUM") {
    markdown.push("- MEDIUM risk: verify callers and add tests for caller paths.");
  } else {
    markdown.push("- LOW risk: graph freshness and extraction quality passed the trust gate; still run task verification.");
  }
  if (graph) {
    markdown.push(`- graph.json nodes=${graph.stats?.nodes ?? graph.nodes?.length ?? 0} edges=${graph.stats?.edges ?? graph.edges?.length ?? 0}`);
  } else {
    markdown.push("- graph.json missing — run `./scripts/nexus-graph.sh`.");
  }
  markdown.push("");
  return markdown.join("\n");
}

function emptyReport() {
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    risk: "UNKNOWN",
    level: "UNKNOWN",
    computed_risk: "UNKNOWN",
    score: 0,
    analysis_quality: "UNKNOWN",
    graph_quality: "UNKNOWN",
    graph_freshness: {
      valid: false,
      status: "NOT_EVALUATED",
      reasons: ["no changed files detected"],
    },
    direct_dependents: [],
    uncertainties: ["no changed files detected"],
    unsupported_fields: unsupportedFields(),
    dimensions: {
      supported: false,
      reason: "not computed by the deterministic blast analyzer",
    },
    files: [],
    startFiles: [],
    impacts: [],
    edges: [],
  };
}

function maybeBuildMissingGraph() {
  let graph = readGraph();
  if (graph) return graph;
  try {
    const graphScript = path.join(root, "scripts", "nexus-graph.sh");
    if (fs.existsSync(graphScript)) {
      execSync(`bash "${graphScript}" "${root}"`, {
        stdio: "pipe",
        timeout: 120000,
      });
      graph = readGraph();
    }
  } catch {
    /* report missing graph as UNKNOWN */
  }
  return graph;
}

function writeTaskArtifacts(report, blast, task, markdownRequested) {
  try {
    const outputDirectory = path.join(root, ".opencode", "knowledge", "blast");
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, `task-${task}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(outputDirectory, "latest.json"), JSON.stringify(report, null, 2));
    if (markdownRequested || blast.level === "HIGH") {
      fs.writeFileSync(path.join(outputDirectory, `task-${task}.md`), renderMarkdown(blast, readGraph()));
      console.error(`[nexus-blast] Saved → ${outputDirectory}/task-${task}.md + task-${task}.json`);
    } else {
      console.error(`[nexus-blast] Saved → ${outputDirectory}/task-${task}.json`);
    }
  } catch (error) {
    console.error("[nexus-blast] Failed to save task report:", error.message);
  }
}

const options = parseArgs();

if (options.explain) {
  const graph = maybeBuildMissingGraph();
  const assessment = graphAssessment(graph);
  const reverse = buildReverseIndex(graph);
  const file = normalizeStartFiles([options.explain])[0] || normalizePath(options.explain);
  const direct = [...(reverse.get(file) || [])];
  const fallback = [];
  if (graph && direct.length === 0) {
    const baseName = path.basename(file);
    for (const edge of graph.edges || []) {
      if (!edge.external && (edge.to.includes(baseName) || path.basename(edge.to) === baseName)) {
        fallback.push(edge.from);
      }
    }
  }
  const uncertainties = [
    ...assessment.freshness.reasons,
    ...assessment.qualityReasons,
  ];
  console.log(JSON.stringify({
    file,
    direct_dependents: [...new Set([...direct, ...fallback])],
    analysis_quality: assessment.analysisQuality,
    graph_freshness: assessment.freshness,
    uncertainties: [...new Set(uncertainties)],
  }, null, 2));
  process.exit(0);
}

let startFiles = options.files;
const base = options.base || gitBaseBranch();
if (!startFiles) {
  startFiles = changedFiles(base);
  if (startFiles.length === 0) {
    try {
      const output = execSync(
        "git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null",
        { encoding: "utf8" },
      );
      startFiles = output.split("\n").map((value) => value.trim()).filter(Boolean).map(normalizePath);
    } catch {
      startFiles = [];
    }
  }
}
startFiles = normalizeStartFiles(startFiles);

if (startFiles.length === 0) {
  console.log(JSON.stringify(emptyReport(), null, 2));
  process.exit(0);
}

const graph = maybeBuildMissingGraph();
const assessment = graphAssessment(graph, startFiles);
const reverseIndex = buildReverseIndex(graph);
const blast = computeBlast(startFiles, graph, reverseIndex, options.depth, assessment);
const report = compactReport(blast);

if (options.mermaidOnly) {
  console.log(renderMermaid(blast));
} else if (options.markdown) {
  console.log(renderMarkdown(blast, graph));
  console.log("\n---JSON---\n");
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(JSON.stringify(report, null, 2));
  if (blast.level === "HIGH") {
    console.log("\n---MERMAID---\n");
    console.log(renderMermaid(blast));
  }
}

if (options.task) writeTaskArtifacts(report, blast, options.task, options.markdown);
