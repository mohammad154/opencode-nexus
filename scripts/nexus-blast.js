#!/usr/bin/env node
/**
 * nexus-blast.js — Lite blast-radius analysis (regex graph fallback).
 *
 * Default output: compact JSON (risk, dependents, uncertainties, reserved dimensions).
 * Mermaid: only with --mermaid, or automatically when risk is HIGH.
 * Markdown reports: --markdown or --task (task writes JSON always; MD when --markdown or HIGH).
 *
 * Usage:
 *   node scripts/nexus-blast.js
 *   node scripts/nexus-blast.js --base main
 *   node scripts/nexus-blast.js --files src/a.ts,src/b.ts
 *   node scripts/nexus-blast.js --json          # explicit JSON (default)
 *   node scripts/nexus-blast.js --mermaid       # Mermaid only
 *   node scripts/nexus-blast.js --markdown      # human MD + JSON
 *   node scripts/nexus-blast.js --task 3
 *   node scripts/nexus-blast.js --explain src/foo.ts
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const root = (() => {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
})();

function readGraph() {
  const gpath = path.join(root, ".opencode", "knowledge", "graph.json");
  if (!fs.existsSync(gpath)) return null;
  try {
    return JSON.parse(fs.readFileSync(gpath, "utf8"));
  } catch {
    return null;
  }
}

function buildReverseIndex(graph) {
  const rev = new Map();
  for (const e of graph?.edges || []) {
    if (e.external) continue;
    if (!rev.has(e.to)) rev.set(e.to, []);
    rev.get(e.to).push(e.from);
  }
  return rev;
}

function normalizePath(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
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
  for (const b of ["main", "master", "develop"]) {
    try {
      execSync(`git show-ref --verify --quiet refs/heads/${b}`);
      return b;
    } catch {
      /* ignore */
    }
  }
  return "main";
}

function changedFiles(base) {
  try {
    const out = execSync(
      `git diff --name-only ${base}...HEAD 2>/dev/null || git diff --name-only --cached 2>/dev/null || git diff --name-only 2>/dev/null`,
      { encoding: "utf8" },
    );
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => p.replace(/\\/g, "/"));
  } catch {
    return [];
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    base: null,
    files: null,
    mermaidOnly: false,
    jsonOnly: false,
    markdown: false,
    task: null,
    explain: null,
    depth: 2,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--base") opts.base = args[++i];
    else if (a === "--files")
      opts.files = args[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--mermaid") opts.mermaidOnly = true;
    else if (a === "--json") opts.jsonOnly = true;
    else if (a === "--markdown") opts.markdown = true;
    else if (a === "--task") opts.task = args[++i];
    else if (a === "--explain") opts.explain = args[++i];
    else if (a === "--depth") opts.depth = parseInt(args[++i], 10) || 2;
  }
  return opts;
}

function computeBlast(startFiles, graph, revIndex, maxDepth = 2) {
  const visited = new Set();
  const queue = startFiles.map((f) => ({ file: f, depth: 0, path: [f] }));
  const impacts = [];
  const edges = [];
  const uncertainties = [];

  const normalizedGraph = new Map();
  for (const n of graph?.nodes || []) normalizedGraph.set(n.id, n);

  if (!graph) {
    uncertainties.push("graph.json missing — dependents may be incomplete");
  }

  let inferredEdges = 0;
  for (const e of graph?.edges || []) {
    if (
      e.confidence === "INFERRED" ||
      (typeof e.confidence_score === "number" && e.confidence_score < 1)
    ) {
      inferredEdges++;
    }
  }
  if (inferredEdges > 0) {
    uncertainties.push(
      `${inferredEdges} graph edge(s) inferred (Lite regex) — treat dependents as incomplete`,
    );
  }

  while (queue.length > 0) {
    const { file, depth, path: chain } = queue.shift();
    if (visited.has(file + ":" + depth)) continue;
    visited.add(file + ":" + depth);
    if (depth > maxDepth) continue;

    let direct = revIndex.get(file) || [];

    if (direct.length === 0 && graph) {
      const base = path.basename(file);
      for (const [toKey, fromList] of revIndex.entries()) {
        const toBase = path.basename(toKey);
        if (
          toBase === base ||
          toKey === file ||
          normalizePath(toKey).includes(path.basename(file, path.extname(file)))
        ) {
          for (const f of fromList) if (!direct.includes(f)) direct.push(f);
        }
      }
    }

    for (const dep of direct) {
      if (chain.includes(dep)) continue;
      edges.push({ from: file, to: dep, depth: depth + 1 });
      const entry = {
        file: dep,
        depth: depth + 1,
        via: [...chain, dep],
        direct: depth === 0,
      };
      if (!impacts.some((x) => x.file === dep)) impacts.push(entry);
      if (depth + 1 < maxDepth)
        queue.push({ file: dep, depth: depth + 1, path: [...chain, dep] });
    }
  }

  let score = 0;
  for (const imp of impacts) {
    score += imp.direct ? 3 : imp.depth === 1 ? 2 : 1;
  }
  let level = "LOW";
  if (score >= 15 || impacts.length >= 10) level = "HIGH";
  else if (score >= 5 || impacts.length >= 3) level = "MEDIUM";

  if (impacts.length === 0 && uncertainties.length > 0) {
    uncertainties.push(
      "no downstream dependents detected under Lite graph — do not treat as proven safe",
    );
  }

  return {
    startFiles,
    impacts,
    edges,
    score,
    level,
    risk: level,
    changed_symbols: [],
    direct_dependents: impacts.filter((i) => i.direct).map((i) => i.file),
    tests: [],
    uncertainties,
    dimensions: {},
  };
}

function renderMermaid(blast) {
  const lines = ["```mermaid", "flowchart TD"];
  const idMap = new Map();
  let idCounter = 0;
  const getId = (f) => {
    if (!idMap.has(f)) {
      const safe = `n${idCounter++}_${path.basename(f).replace(/[^a-zA-Z0-9]/g, "_")}`;
      idMap.set(f, safe);
    }
    return idMap.get(f);
  };

  for (const f of blast.startFiles) {
    const id = getId(f);
    lines.push(`  ${id}[\"${path.basename(f)}<br/>${f}\"]`);
    lines.push(`  style ${id} fill:#ff6b6b,stroke:#c92a2a,color:#fff`);
  }

  for (const imp of blast.impacts) {
    const id = getId(imp.file);
    if (!blast.startFiles.includes(imp.file)) {
      lines.push(`  ${id}[\"${path.basename(imp.file)}\"]`);
      if (imp.depth === 1) lines.push(`  style ${id} fill:#ffd43b,stroke:#e67700`);
      else lines.push(`  style ${id} fill:#ffe066,stroke:#f59f00`);
    }
  }

  for (const e of blast.edges) {
    lines.push(`  ${getId(e.from)} --> ${getId(e.to)}`);
  }

  lines.push("```");
  return lines.join("\n");
}

function compactReport(blast) {
  return {
    schema_version: "1.0",
    risk: blast.risk || blast.level,
    level: blast.level,
    score: blast.score,
    changed_symbols: blast.changed_symbols || [],
    direct_dependents: blast.direct_dependents || [],
    tests: blast.tests || [],
    uncertainties: blast.uncertainties || [],
    dimensions: blast.dimensions || {},
    files: blast.startFiles,
    impacts: blast.impacts,
    edges: blast.edges,
  };
}

function renderMarkdown(blast, graph) {
  const md = [];
  md.push(`# Blast Radius – risk: **${blast.level}** (score ${blast.score})`);
  md.push("");
  md.push(`Changed files (${blast.startFiles.length}):`);
  for (const f of blast.startFiles) md.push(`- \`${f}\``);
  md.push("");
  if (blast.uncertainties?.length) {
    md.push("## Uncertainties");
    for (const u of blast.uncertainties) md.push(`- ${u}`);
    md.push("");
  }
  if (blast.impacts.length === 0) {
    md.push(
      "**No downstream dependents detected** under Lite graph. Do not treat as proven isolation — verify with tests.",
    );
  } else {
    md.push(`**${blast.impacts.length} downstream file(s) may be affected**:`);
    md.push("");
    md.push("| File | Depth | Via |");
    md.push("|------|-------|-----|");
    for (const imp of blast.impacts.slice(0, 60)) {
      md.push(`| \`${imp.file}\` | ${imp.depth} | ${imp.via.join(" → ")} |`);
    }
  }
  md.push("");
  const wantMermaid = blast.level === "HIGH";
  if (wantMermaid) {
    md.push("## Mermaid (blast radius diagram)");
    md.push("");
    md.push(renderMermaid(blast));
    md.push("");
  } else {
    md.push("_Mermaid omitted (use `--mermaid` or HIGH risk)._");
    md.push("");
  }
  md.push("## Implementer guidance");
  if (blast.level === "HIGH") {
    md.push(
      "- HIGH risk: many callers. Update scope, run downstream tests, consider splitting.",
    );
  } else if (blast.level === "MEDIUM") {
    md.push("- MEDIUM risk: verify callers; add tests for caller paths.");
  } else {
    md.push("- LOW risk under Lite scoring — still run task verification.");
  }
  if (graph) {
    md.push(
      `- graph.json nodes=${graph.stats?.nodes ?? graph.nodes?.length} edges=${graph.stats?.edges ?? graph.edges?.length}`,
    );
  } else {
    md.push("- graph.json missing – run `./scripts/nexus-graph.sh`.");
  }
  md.push("");
  return md.join("\n");
}

const opts = parseArgs();

if (opts.explain) {
  const graph = readGraph();
  const rev = buildReverseIndex(graph);
  const direct = rev.get(opts.explain) || [];
  const fallback = [];
  const baseName = path.basename(opts.explain);
  if (graph && direct.length === 0) {
    for (const e of graph.edges || []) {
      if (
        !e.external &&
        (e.to.includes(baseName) || path.basename(e.to) === baseName)
      ) {
        fallback.push(e.from);
      }
    }
  }
  const all = [...new Set([...direct, ...fallback])];
  console.log(
    JSON.stringify({ file: opts.explain, direct_dependents: all }, null, 2),
  );
  process.exit(0);
}

let startFiles = opts.files;
const base = opts.base || gitBaseBranch();
if (!startFiles) {
  startFiles = changedFiles(base);
  if (startFiles.length === 0) {
    try {
      const out = execSync(
        "git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null",
        { encoding: "utf8" },
      );
      startFiles = out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => p.replace(/\\/g, "/"));
    } catch {
      startFiles = [];
    }
  }
}

if (startFiles.length === 0) {
  const empty = {
    schema_version: "1.0",
    risk: "UNKNOWN",
    level: "UNKNOWN",
    score: 0,
    changed_symbols: [],
    direct_dependents: [],
    tests: [],
    uncertainties: ["no changed files detected"],
    dimensions: {},
    files: [],
    impacts: [],
    edges: [],
  };
  console.log(JSON.stringify(empty, null, 2));
  process.exit(0);
}

let graph = readGraph();
if (!graph) {
  try {
    const shPath = path.join(root, "scripts", "nexus-graph.sh");
    if (fs.existsSync(shPath)) {
      execSync(`bash "${shPath}" "${root}"`, {
        stdio: "pipe",
        timeout: 120000,
      });
      graph = readGraph();
    }
  } catch {
    /* keep null */
  }
}

const revIndex = buildReverseIndex(graph);
const blast = computeBlast(startFiles, graph, revIndex, opts.depth);
const report = compactReport(blast);
const wantMermaid = opts.mermaidOnly || blast.level === "HIGH";

if (opts.mermaidOnly) {
  console.log(renderMermaid(blast));
} else if (opts.markdown) {
  console.log(renderMarkdown(blast, graph));
  console.log("\n---JSON---\n");
  console.log(JSON.stringify(report, null, 2));
  if (wantMermaid && blast.level !== "HIGH") {
    console.log("\n---MERMAID---\n");
    console.log(renderMermaid(blast));
  }
} else {
  // Default: compact JSON; for HIGH risk also emit Mermaid after the JSON block
  console.log(JSON.stringify(report, null, 2));
  if (blast.level === "HIGH") {
    console.log("\n---MERMAID---\n");
    console.log(renderMermaid(blast));
  }
}

if (opts.task) {
  try {
    const outDir = path.join(root, ".opencode", "knowledge", "blast");
    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, `task-${opts.task}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    const latest = path.join(outDir, "latest.json");
    fs.writeFileSync(latest, JSON.stringify(report, null, 2));
    if (opts.markdown || blast.level === "HIGH") {
      const mdPath = path.join(outDir, `task-${opts.task}.md`);
      fs.writeFileSync(mdPath, renderMarkdown(blast, graph));
      console.error(`[nexus-blast] Saved → ${mdPath} + ${jsonPath}`);
    } else {
      console.error(`[nexus-blast] Saved → ${jsonPath}`);
    }
  } catch (e) {
    console.error("[nexus-blast] Failed to save task report:", e.message);
  }
}
