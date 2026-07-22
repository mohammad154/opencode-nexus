#!/usr/bin/env node
/**
 * nexus-blast.js — blast-radius analysis for Nexus implementers.
 * From CodeLookup: static import graph + git diff → Mermaid blast diagram.
 *
 * Usage:
 *   node scripts/nexus-blast.js                          # use git diff base...HEAD
 *   node scripts/nexus-blast.js --base main               # explicit base
 *   node scripts/nexus-blast.js --files src/a.ts,src/b.ts # explicit file list
 *   node scripts/nexus-blast.js --mermaid                 # output only mermaid block
 *   node scripts/nexus-blast.js --json                    # output only json
 *   node scripts/nexus-blast.js --task 3                  # writes .opencode/knowledge/blast/task-3.md
 *   node scripts/nexus-blast.js --explain src/foo.ts      # who depends on this file?
 *
 * Input:  .opencode/knowledge/graph.json (build via nexus-graph.sh if missing)
 * Output: stdout + optional .opencode/knowledge/blast/*.md
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const root = (() => {
  try { return execSync("git rev-parse --show-toplevel", {encoding:"utf8"}).trim(); }
  catch { return process.cwd(); }
})();

function readGraph() {
  const gpath = path.join(root, ".opencode", "knowledge", "graph.json");
  if (!fs.existsSync(gpath)) return null;
  try { return JSON.parse(fs.readFileSync(gpath, "utf8")); } catch { return null; }
}

function buildReverseIndex(graph) {
  // to -> [from,...]  (who imports this file)
  const rev = new Map();
  for (const e of (graph?.edges || [])) {
    if (e.external) continue;
    if (!rev.has(e.to)) rev.set(e.to, []);
    rev.get(e.to).push(e.from);
    // Also try suffix matching: if edge.to is import specifier not absolute
    // Best-effort: match last segment
  }
  return rev;
}

function normalizePath(p) {
  return p.replace(/\\/g,"/").replace(/^\.\//,"").replace(/^.*\/\.opencode\/knowledge\/.*$/,"");
}

// Git helpers
function gitBaseBranch() {
  try {
    const head = execSync("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'", {encoding:"utf8"}).trim();
    if (head) return head;
  } catch {}
  for (const b of ["main","master","develop"]) {
    try { execSync(`git show-ref --verify --quiet refs/heads/${b}`); return b; } catch {}
  }
  return "main";
}

function changedFiles(base) {
  try {
    const out = execSync(`git diff --name-only ${base}...HEAD 2>/dev/null || git diff --name-only --cached 2>/dev/null || git diff --name-only 2>/dev/null`, {encoding:"utf8"});
    return out.split("\n").map(s=>s.trim()).filter(Boolean).map(p=>p.replace(/\\/g,"/"));
  } catch { return []; }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { base: null, files: null, mermaidOnly: false, jsonOnly: false, task: null, explain: null, depth: 2 };
  for (let i=0;i<args.length;i++) {
    const a=args[i];
    if (a==="--base") opts.base=args[++i];
    else if (a==="--files") opts.files=args[++i].split(",").map(s=>s.trim()).filter(Boolean);
    else if (a==="--mermaid") opts.mermaidOnly=true;
    else if (a==="--json") opts.jsonOnly=true;
    else if (a==="--task") opts.task=args[++i];
    else if (a==="--explain") opts.explain=args[++i];
    else if (a==="--depth") opts.depth=parseInt(args[++i],10)||2;
    else if (a.startsWith("--")) { /* ignore */ }
  }
  return opts;
}

function computeBlast(startFiles, graph, revIndex, maxDepth=2) {
  // BFS from changed files through reverse index (who depends on changed files)
  const visited = new Set();
  const queue = startFiles.map(f => ({ file: f, depth: 0, path: [f] }));
  const impacts = []; // {file, depth, via:[chain], direct:Boolean}
  const edges = [];   // for mermaid: from -> to

  const normalizedGraph = new Map();
  for (const n of (graph?.nodes || [])) normalizedGraph.set(n.id, n);

  while (queue.length > 0) {
    const { file, depth, path: chain } = queue.shift();
    if (visited.has(file + ":" + depth)) continue;
    visited.add(file + ":" + depth);
    if (depth > maxDepth) continue;

    // Find direct dependents via reverse index (exact match)
    let direct = revIndex.get(file) || [];

    // Fallback: suffix matching – graph stores relative paths, import might be bare
    if (direct.length === 0 && graph) {
      const base = path.basename(file);
      for (const [toKey, fromList] of revIndex.entries()) {
        // heuristic: if toKey ends with file name or file contains/imports referencing basename
        const toBase = path.basename(toKey);
        if (toBase === base || toKey === file || normalizedPath(toKey).includes(path.basename(file, path.extname(file)))) {
          // only if not already counted
          for (const f of fromList) if (!direct.includes(f)) direct.push(f);
        }
      }
    }

    for (const dep of direct) {
      if (chain.includes(dep)) continue; // cycle guard
      edges.push({ from: file, to: dep, depth: depth+1 });
      const entry = { file: dep, depth: depth+1, via: [...chain, dep], direct: depth===0 };
      // dedup impacts by file keeping shallowest
      if (!impacts.some(x => x.file===dep)) impacts.push(entry);
      if (depth+1 < maxDepth) queue.push({ file: dep, depth: depth+1, path: [...chain, dep] });
    }
  }

  // Risk scoring
  let score = 0;
  for (const imp of impacts) {
    score += imp.direct ? 3 : (imp.depth===1 ? 2 : 1);
  }
  let level = "LOW";
  if (score >= 15 || impacts.length >= 10) level = "HIGH";
  else if (score >= 5 || impacts.length >= 3) level = "MEDIUM";

  return { startFiles, impacts, edges, score, level };
}

function normalizedPath(p){ return String(p).replace(/\\/g,"/").replace(/^\.\//,""); }

function renderMermaid(blast) {
  const lines = ["```mermaid", "flowchart TD"];
  const idMap = new Map();
  let idCounter = 0;
  const getId = (f) => {
    if (!idMap.has(f)) {
      const safe = `n${idCounter++}_${path.basename(f).replace(/[^a-zA-Z0-9]/g,"_")}`;
      idMap.set(f, safe);
    }
    return idMap.get(f);
  };

  // Nodes for changed files (highlighted)
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

  // Edges
  for (const e of blast.edges) {
    const fromId = getId(e.from);
    const toId = getId(e.to);
    lines.push(`  ${fromId} --> ${toId}`);
  }

  lines.push("```");
  return lines.join("\n");
}

function renderMarkdown(blast, graph) {
  const md = [];
  md.push(`# Blast Radius – risk: **${blast.level}** (score ${blast.score})`);
  md.push("");
  md.push(`Changed files (${blast.startFiles.length}):`);
  for (const f of blast.startFiles) md.push(`- \`${f}\``);
  md.push("");
  if (blast.impacts.length === 0) {
    md.push("**No downstream dependents detected** (or graph missing for these paths). Safe to change in isolation – but verify with tests.");
  } else {
    md.push(`**${blast.impacts.length} downstream file(s) may be affected** (depth ≤ search):`);
    md.push("");
    md.push("| File | Depth | Via |");
    md.push("|------|-------|-----|");
    for (const imp of blast.impacts.slice(0, 60)) {
      const via = imp.via.join(" → ");
      md.push(`| \`${imp.file}\` | ${imp.depth} | ${via} |`);
    }
    if (blast.impacts.length > 60) md.push(`| ... and ${blast.impacts.length-60} more – see json |`);
  }
  md.push("");
  md.push("## Mermaid (blast radius diagram)");
  md.push("");
  md.push(renderMermaid(blast));
  md.push("");
  md.push("## Implementer guidance");
  if (blast.level === "HIGH") {
    md.push("- ⚠️  HIGH risk: many callers. Update this task's scope in writing, run all downstream tests, consider splitting task.");
    md.push("- Ensure .opencode/tasks/task-N.md notes dependent files.");
  } else if (blast.level === "MEDIUM") {
    md.push("- MEDIUM risk: some callers. Verify callers still behave correctly after the change; add tests for caller paths.");
  } else {
    md.push("- LOW risk: isolated or leaf module. Minimal blast. Proceed, but still run task verification.");
  }
  md.push("- Review diff with: `git diff <base>...feature/task-N-<slug>`");
  md.push("- When in doubt, expand blast search: `node scripts/nexus-blast.js --depth 3 --files <file>`");
  md.push("");
  md.push("## How graph was built");
  if (graph) {
    md.push(`- graph.json nodes=${graph.stats?.nodes ?? graph.nodes?.length} edges=${graph.stats?.edges ?? graph.edges?.length} generated=${graph.generated_at || "unknown"}`);
  } else {
    md.push("- graph.json missing – results based on git diff only. Run `./scripts/nexus-graph.sh` to improve accuracy.");
  }
  md.push(`- Search depth: ${blast.impacts.reduce((m,i)=>Math.max(m,i.depth),0)} (max configured: BFS)`);
  md.push("");
  return md.join("\n");
}

// ── main ────────────────────────────────────────────────
const opts = parseArgs();

// Single-file explain mode
if (opts.explain) {
  const graph = readGraph();
  const rev = buildReverseIndex(graph);
  const direct = rev.get(opts.explain) || [];
  // Fallback: any edge.to containing basename
  const fallback = [];
  const base = path.basename(opts.explain);
  if (graph && direct.length===0) {
    for (const e of graph.edges || []) {
      if (!e.external && (e.to.includes(base) || path.basename(e.to)===base) ) {
        fallback.push(e.from);
      }
    }
  }
  const all = [...new Set([...direct, ...fallback])];
  console.log(`File: ${opts.explain}`);
  console.log(`Direct dependents: ${all.length}`);
  for (const f of all.slice(0,100)) console.log(`  - ${f}`);
  if (!graph) console.log("\n(graph.json missing – run nexus-graph.sh first for richer results)");
  process.exit(0);
}

let startFiles = opts.files;
let base = opts.base || gitBaseBranch();
if (!startFiles) {
  startFiles = changedFiles(base);
  if (startFiles.length === 0) {
    // fallback: staged + unstaged files
    try {
      const out = execSync("git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null", {encoding:"utf8"});
      startFiles = out.split("\n").map(s=>s.trim()).filter(Boolean).map(p=>p.replace(/\\/g,"/"));
    } catch { startFiles = []; }
  }
}

if (startFiles.length === 0) {
  console.log("No changed files detected (nothing in diff against base).");
  console.log(`Tip: specify files: node scripts/nexus-blast.js --files src/foo.ts,src/bar.ts`);
  process.exit(0);
}

let graph = readGraph();
if (!graph) {
  console.log("[nexus-blast] graph.json missing – attempting auto-build...");
  try {
    const shPath = path.join(root, "scripts", "nexus-graph.sh");
    if (fs.existsSync(shPath)) execSync(`bash "${shPath}" "${root}"`, {stdio:"inherit", timeout: 120000});
    graph = readGraph();
  } catch (e) {
    console.log("[nexus-blast] auto-build failed:", e.message);
  }
}

const revIndex = buildReverseIndex(graph);
const blast = computeBlast(startFiles, graph, revIndex, opts.depth);

if (opts.mermaidOnly) {
  console.log(renderMermaid(blast));
} else if (opts.jsonOnly) {
  console.log(JSON.stringify(blast, null, 2));
} else {
  console.log(renderMarkdown(blast, graph));
  console.log("\n---JSON---\n");
  console.log(JSON.stringify({ files: blast.startFiles, level: blast.level, score: blast.score, impacts: blast.impacts, edges: blast.edges }, null, 2));
}

// Persist per-task if requested
if (opts.task) {
  try {
    const outDir = path.join(root, ".opencode", "knowledge", "blast");
    fs.mkdirSync(outDir, {recursive:true});
    const mdPath = path.join(outDir, `task-${opts.task}.md`);
    fs.writeFileSync(mdPath, renderMarkdown(blast, graph));
    const jsonPath = path.join(outDir, `task-${opts.task}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify({ files: blast.startFiles, level: blast.level, score: blast.score, impacts: blast.impacts, edges: blast.edges }, null, 2));
    console.error(`\n[nexus-blast] Saved → ${mdPath} + .json`);
  } catch (e) {
    console.error("[nexus-blast] Failed to save task report:", e.message);
  }
}
