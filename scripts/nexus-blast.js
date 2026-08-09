#!/usr/bin/env node
/**
 * nexus-blast.js — Graphify-backed blast-radius analysis.
 *
 * Graphify owns graph extraction and refresh. Nexus keeps the historical
 * report shape and risk state machine, but only emits a trusted risk when a
 * fresh, directed Graphify graph maps every changed file. Missing, malformed,
 * stale, undirected, or refresh-failed evidence is always UNKNOWN.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  GRAPHIFY_RELATIONS,
  normalizeGraphifyFile,
  prepareGraphifyGraph,
  reverseTraverseGraphify,
} from "./lib/graphify.js";

const REPORT_SCHEMA_VERSION = "1.1";

const root = path.resolve(
  process.env.NEXUS_WORKTREE || (() => {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    });
    return result.status === 0
      ? String(result.stdout || "").trim() || process.cwd()
      : process.cwd();
  })(),
);

function normalizePath(value) {
  return normalizeGraphifyFile(String(value), root) || String(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

function headCommit(repoRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0
    ? String(result.stdout || "").trim() || "unknown"
    : "unknown";
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

function gitBaseBranch() {
  const remoteHead = spawnSync(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd: root, encoding: "utf8" },
  );
  if (remoteHead.status === 0) {
    const value = String(remoteHead.stdout || "").trim().replace(/^refs\/remotes\/origin\//, "");
    if (value) return value;
  }
  for (const branch of ["main", "master", "develop"]) {
    const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status === 0) return branch;
  }
  return "main";
}

function changedFiles(base) {
  const commands = base
    ? [["diff", "--name-only", `${base}...HEAD`], ["diff", "--name-only", "--cached"], ["diff", "--name-only"]]
    : [["diff", "--name-only", "--cached"], ["diff", "--name-only"]];
  for (const command of commands) {
    const result = spawnSync("git", command, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) continue;
    const values = String(result.stdout || "")
      .split("\n")
      .map((value) => normalizePath(value.trim()))
      .filter(Boolean);
    if (values.length > 0) return [...new Set(values)];
  }
  return [];
}

function normalizeStartFiles(files) {
  return [...new Set((files || [])
    .map((file) => normalizeGraphifyFile(String(file), root))
    .filter(Boolean))];
}

function prepareGraph() {
  return prepareGraphifyGraph({ worktree: root });
}

function missingFreshness(status = "MISSING", reasons = []) {
  return {
    valid: false,
    status,
    reasons: reasons.length > 0 ? reasons : ["Graphify graph is missing or invalid"],
    current_head: headCommit(root),
  };
}

function graphAssessment(snapshot, startFiles = []) {
  const freshness = snapshot?.freshness || missingFreshness(snapshot?.status);
  const mapping = snapshot
    ? reverseTraverseGraphify(snapshot, startFiles, { worktree: root, depth: 0 }).mapping
    : { files: startFiles, mapped: [], unmapped: startFiles };
  const qualityReasons = [];
  if (!snapshot) qualityReasons.push("Graphify graph is unavailable");
  if (snapshot && snapshot.status !== "FRESH") {
    qualityReasons.push(`Graphify graph status is ${snapshot.status}`);
  }
  if (mapping.unmapped.length > 0) {
    qualityReasons.push(`changed file is not mapped by Graphify: ${mapping.unmapped.join(", ")}`);
  }
  const trusted = Boolean(
    snapshot?.ok === true &&
    snapshot?.directed === true &&
    freshness.valid &&
    mapping.unmapped.length === 0,
  );
  return {
    freshness,
    mapping,
    trusted,
    graphQuality: trusted ? "PRECISE" : "UNKNOWN",
    analysisQuality: trusted ? "PRECISE" : "UNKNOWN",
    qualityReasons,
  };
}

function computeBlast(startFiles, snapshot, maxDepth, assessment) {
  const traversal = snapshot
    ? reverseTraverseGraphify(snapshot, startFiles, { worktree: root, depth: maxDepth })
    : { impacts: [], edges: [], mapping: assessment.mapping, start_nodes: [] };
  const uncertainties = [
    ...(assessment.freshness?.reasons || []),
    ...(assessment.qualityReasons || []),
  ];
  if (snapshot?.refresh && !snapshot.refresh.ok) {
    uncertainties.push(
      snapshot.refresh.error || snapshot.refresh.stderr || "Graphify refresh failed",
    );
  }
  if (traversal.impacts.length === 0 && uncertainties.length > 0) {
    uncertainties.push(
      "no downstream dependents detected under the available Graphify graph — do not treat this as proven safe",
    );
  }

  let score = 0;
  for (const impact of traversal.impacts) {
    score += impact.direct ? 3 : impact.depth === 1 ? 2 : 1;
  }
  let computedRisk = "LOW";
  if (score >= 15 || traversal.impacts.length >= 10) computedRisk = "HIGH";
  else if (score >= 5 || traversal.impacts.length >= 3) computedRisk = "MEDIUM";

  const level = assessment.trusted ? computedRisk : "UNKNOWN";
  return {
    startFiles,
    impacts: traversal.impacts,
    edges: traversal.edges,
    score,
    level,
    risk: level,
    computed_risk: assessment.trusted ? computedRisk : "UNKNOWN",
    analysis_quality: assessment.analysisQuality,
    graph_quality: assessment.graphQuality,
    graph_freshness: assessment.freshness,
    direct_dependents: traversal.impacts
      .filter((impact) => impact.direct)
      .map((impact) => impact.file),
    uncertainties: [...new Set(uncertainties)],
    graph_provider: "graphify",
    graph_path: snapshot?.path || null,
    graphify_relations: [...GRAPHIFY_RELATIONS],
  };
}

function unsupportedFields() {
  return {
    changed_symbols: "not extracted by the Nexus blast-report adapter",
    tests: "not discovered by the Nexus blast-report adapter",
    dimensions: "not computed by the Nexus blast-report adapter",
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
    analysis_complete: blast.level !== "UNKNOWN",
    graph_quality: blast.graph_quality,
    graph_freshness: blast.graph_freshness,
    graph_provider: blast.graph_provider,
    graph_path: blast.graph_path,
    graphify_relations: blast.graphify_relations,
    direct_dependents: blast.direct_dependents || [],
    uncertainties: blast.uncertainties || [],
    unsupported_fields: unsupportedFields(),
    placeholder_fields: ["changed_symbols", "tests", "dimensions"],
    dimensions: {
      supported: false,
      reason: "not computed by the Nexus blast-report adapter",
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

function renderMarkdown(blast, snapshot) {
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
      "**No downstream dependents detected** under the available Graphify graph. Do not treat this as proven isolation unless analysis quality is PRECISE and freshness is FRESH.",
    );
  } else {
    markdown.push(`**${blast.impacts.length} downstream file(s) may be affected**:`);
    markdown.push("");
    markdown.push("| File | Depth | Via | Relation |");
    markdown.push("|------|-------|-----|----------|");
    for (const impact of blast.impacts.slice(0, 60)) {
      markdown.push(`| \`${impact.file}\` | ${impact.depth} | ${impact.via.join(" → ")} | ${impact.relation || "-"} |`);
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
    markdown.push("- UNKNOWN risk: install Graphify and refresh a fresh directed graph before relying on the score.");
  } else if (blast.level === "HIGH") {
    markdown.push("- HIGH risk: many callers. Update scope, run downstream tests, and consider splitting.");
  } else if (blast.level === "MEDIUM") {
    markdown.push("- MEDIUM risk: verify callers and add tests for caller paths.");
  } else {
    markdown.push("- LOW risk: Graphify freshness and directed extraction passed the trust gate; still run task verification.");
  }
  if (snapshot) {
    const edgeCount = snapshot.edges?.length ?? snapshot.links?.length ?? 0;
    markdown.push(`- Graphify graph: ${snapshot.nodes?.length ?? 0} nodes, ${edgeCount} edges at \`${snapshot.path}\`.`);
  } else {
    markdown.push("- Graphify graph is unavailable — run `graphify extract . --code-only --directed --no-viz`.");
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
    analysis_complete: false,
    graph_quality: "UNKNOWN",
    graph_freshness: missingFreshness("NOT_EVALUATED", ["no changed files detected"]),
    graph_provider: "graphify",
    graph_path: null,
    graphify_relations: [...GRAPHIFY_RELATIONS],
    direct_dependents: [],
    uncertainties: ["no changed files detected"],
    unsupported_fields: unsupportedFields(),
    placeholder_fields: ["changed_symbols", "tests", "dimensions"],
    dimensions: {
      supported: false,
      reason: "not computed by the Nexus blast-report adapter",
    },
    files: [],
    startFiles: [],
    impacts: [],
    edges: [],
  };
}

function writeTaskArtifacts(report, blast, snapshot, task, markdownRequested) {
  try {
    const outputDirectory = path.join(root, ".opencode", "blast");
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, `task-${task}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(outputDirectory, "latest.json"), JSON.stringify(report, null, 2));
    if (markdownRequested || blast.level === "HIGH") {
      fs.writeFileSync(path.join(outputDirectory, `task-${task}.md`), renderMarkdown(blast, snapshot));
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
  const prepared = prepareGraph();
  const file = normalizeStartFiles([options.explain])[0] || normalizePath(options.explain);
  const assessment = graphAssessment(prepared, [file]);
  const traversal = prepared
    ? reverseTraverseGraphify(prepared, [file], { worktree: root, depth: 1 })
    : { impacts: [], mapping: { unmapped: [file] } };
  console.log(JSON.stringify({
    file,
    direct_dependents: traversal.impacts.filter((impact) => impact.direct).map((impact) => impact.file),
    analysis_quality: assessment.analysisQuality,
    graph_freshness: assessment.freshness,
    uncertainties: [...new Set([
      ...(assessment.freshness.reasons || []),
      ...(assessment.qualityReasons || []),
    ])],
  }, null, 2));
  process.exit(0);
}

let startFiles = options.files;
const base = options.base || gitBaseBranch();
if (!startFiles) {
  startFiles = changedFiles(base);
  if (startFiles.length === 0) {
    const result = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
    });
    startFiles = result.status === 0
      ? String(result.stdout || "").split("\n").filter(Boolean)
      : [];
  }
}
startFiles = normalizeStartFiles(startFiles);

if (startFiles.length === 0) {
  console.log(JSON.stringify(emptyReport(), null, 2));
  process.exit(0);
}

const prepared = prepareGraph();
const assessment = graphAssessment(prepared, startFiles);
const blast = computeBlast(startFiles, prepared, options.depth, assessment);
const report = compactReport(blast);

if (options.mermaidOnly) {
  console.log(renderMermaid(blast));
} else if (options.markdown) {
  console.log(renderMarkdown(blast, prepared));
  console.log("\n---JSON---\n");
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(JSON.stringify(report, null, 2));
  if (blast.level === "HIGH") {
    console.log("\n---MERMAID---\n");
    console.log(renderMermaid(blast));
  }
}

if (options.task) writeTaskArtifacts(report, blast, prepared, options.task, options.markdown);
