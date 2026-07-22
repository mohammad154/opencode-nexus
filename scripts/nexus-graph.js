#!/usr/bin/env node
/**
 * nexus-graph.js — precise dependency graph builder (Node path)
 * Inputs:  argv[2]=file-list, argv[3]=root, argv[4]=outDir
 * Outputs: $outDir/graph.json
 *
 * Heuristics per language:
 *  - JS/TS: import x from 'y', export, require()
 *  - Python: import x, from x import y
 *  - Go: import "x" / import ( ... )
 *  - Rust/Java/C#: use / import (coarse)
 *  - Shell/md/json are indexed but not edge-extracted
 *
 * Edges tagged EXTRACTED (explicit import) or INFERRED (relative-resolution hint).
 */

import fs from "fs";
import path from "path";

const fileListPath = process.argv[2];
const root = process.argv[3] || process.cwd();
const outDir = process.argv[4] || path.join(root, ".opencode", "knowledge");

if (!fileListPath || !fs.existsSync(fileListPath)) {
  console.error("[nexus-graph.js] file list missing:", fileListPath);
  process.exit(1);
}

const rawFiles = fs.readFileSync(fileListPath, "utf8")
  .split("\n").map(s => s.trim()).filter(Boolean);

function rel(p) { return path.relative(root, p) || path.basename(p); }

function langOf(file) {
  const ext = path.extname(file).toLowerCase();
  if ([".ts", ".tsx"].includes(ext)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if (ext === ".java") return "java";
  if (ext === ".rb") return "ruby";
  if (ext === ".php") return "php";
  if (ext === ".cs") return "csharp";
  if (ext === ".kt") return "kotlin";
  if (ext === ".swift") return "swift";
  if (ext === ".sh" || ext === ".bash") return "shell";
  if (ext === ".md" || ext === ".mdx") return "markdown";
  if (ext === ".json") return "json";
  if ([".toml", ".yaml", ".yml"].includes(ext)) return "config";
  return "unknown";
}

function escapeId(s) { return s.replace(/\\/g, "/"); }

// Tiny JS/TS import regexes
const RE_JS_FROM   = /(?:import\s+(?:[\w*{}\s,]+\s+from\s+|type\s+)?|\}\s+from\s+|export\s+(?:\*\s+from|{[^}]*}\s+from)\s*)['"]([^'"]+)['"]/g;
const RE_JS_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_JS_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_PY_FROM    = /^\s*from\s+([a-zA-Z0-9_.]+)\s+import\s+/gm;
const RE_PY_IMPORT  = /^\s*import\s+([a-zA-Z0-9_.,\s]+)/gm;
const RE_GO_IMPORT_LINE = /^\s*"([^"]+)"\s*$/gm;
const RE_GO_IMPORT_BLOCK = /import\s*\(\s*([^)]+)\)/gms;

function tryResolveImport(imp, fromFile) {
  // Only attempt to resolve relative imports to graph nodes.
  // Bare specifiers (npm/pip) stay as external edges.
  if (imp.startsWith(".") || imp.startsWith("/")) {
    const base = path.dirname(fromFile);
    const candidates = [
      path.resolve(base, imp),
      path.resolve(base, imp + ".ts"),
      path.resolve(base, imp + ".js"),
      path.resolve(base, imp + ".tsx"),
      path.resolve(base, imp + ".jsx"),
      path.resolve(base, imp + ".py"),
      path.resolve(base, imp + ".go"),
      path.resolve(base, imp, "index.ts"),
      path.resolve(base, imp, "index.js"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        const r = escapeId(rel(c));
        return { to: r, resolved: true };
      }
    }
    // Mark as relative but unresolved → INFERRED intent
    return { to: escapeId(imp), resolved: false };
  }
  // Heuristic: workspace-relative without dot (monorepo alias)
  // e.g. "@/components/foo" or "components/foo" could be internal
  if (imp.startsWith("@/") || imp.startsWith("~/")) {
    return { to: imp, resolved: false };
  }
  return { to: imp, resolved: false, external: true };
}

function extractSymbols(text, lang) {
  let lines = text.split("\n");
  let count = 0;
  // Coarse symbol detector: function/class/const/export
  const RE_SYM = /^\s*(export\s+)?(function|class|const\s+\w+\s*=|let\s+\w+\s*=|def\s+\w+|fn\s+\w+|func\s+\w+|struct\s+\w+|interface\s+\w+|type\s+\w+|enum\s+\w+)/;
  for (const l of lines) if (RE_SYM.test(l)) count++;
  return count;
}

function extractEdges(text, file, lang) {
  const edges = [];
  const fileRel = escapeId(rel(file));

  const push = (imp, kind = "imports") => {
    const spec = imp.trim(); if (!spec) return;
    // Skip obvious noise
    if (/^(node:|bun:|fs|path|os|http|https|url|util|events|crypto)$/.test(spec)) return;
    const resolved = tryResolveImport(spec, file);
    edges.push({
      from: fileRel,
      to: resolved.to,
      relation: "imports",
      confidence: resolved.resolved ? "EXTRACTED" : (resolved.external ? "INFERRED" : "INFERRED"),
      confidence_score: resolved.resolved ? 1.0 : (resolved.external ? 0.9 : 0.75),
      source_file: fileRel,
      external: !!resolved.external,
    });
  };

  if (lang === "javascript" || lang === "typescript") {
    let m;
    while ((m = RE_JS_FROM.exec(text)) !== null) push(m[1]);
    RE_JS_FROM.lastIndex = 0;
    while ((m = RE_JS_IMPORT.exec(text)) !== null) push(m[1]);
    RE_JS_IMPORT.lastIndex = 0;
    while ((m = RE_JS_REQUIRE.exec(text)) !== null) push(m[1]);
    RE_JS_REQUIRE.lastIndex = 0;
  } else if (lang === "python") {
    let m;
    while ((m = RE_PY_FROM.exec(text)) !== null) push(m[1].replace(/\./g, "/"), "imports");
    RE_PY_FROM.lastIndex = 0;
    while ((m = RE_PY_IMPORT.exec(text)) !== null) {
      for (const part of m[1].split(",")) push(part.trim().split(/\s+as\s+/)[0].replace(/\./g, "/"));
    }
    RE_PY_IMPORT.lastIndex = 0;
  } else if (lang === "go") {
    // Single-line imports
    const single = text.match(/^\s*import\s+"([^"]+)"/gm);
    if (single) {
      for (const line of single) {
        const im = line.match(/"([^"]+)"/); if (im) push(im[1]);
      }
    }
    let m;
    while ((m = RE_GO_IMPORT_BLOCK.exec(text)) !== null) {
      const block = m[1];
      let lineRe = /"([^"]+)"/g, lm;
      while ((lm = lineRe.exec(block)) !== null) push(lm[1]);
    }
    RE_GO_IMPORT_BLOCK.lastIndex = 0;
  } else {
    // Fallback generic "import x" / "use x"
    const generics = [...text.matchAll(/^\s*(?:import|use)\s+["']?([a-zA-Z0-9_./@-]+)["']?/gm)].slice(0, 30);
    for (const g of generics) push(g[1]);
  }
  return edges;
}

const nodes = [];
const allEdges = [];
const fileSet = new Set(rawFiles.map(f => escapeId(rel(f))));

for (const file of rawFiles) {
  const r = escapeId(rel(file));
  const lang = langOf(file);
  let text = "";
  try {
    const st = fs.statSync(file);
    if (st.size > 512 * 1024) { // skip huge files
      nodes.push({ id: r, label: path.basename(file), path: r, lang, type: "file", symbol_count: 0, truncated: true, evidence: `${r}:1` });
      continue;
    }
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }

  const symCount = extractSymbols(text, lang);
  nodes.push({
    id: r,
    label: path.basename(file),
    path: r,
    lang,
    type: "file",
    symbol_count: symCount,
    evidence: `${r}:1`,
    size_bytes: text.length,
  });

  const edges = extractEdges(text, file, lang);
  for (const e of edges) allEdges.push(e);
}

const now = new Date().toISOString();

// Dedup edges (from|to|relation)
const seen = new Set();
const deduped = [];
for (const e of allEdges) {
  const k = `${e.from}|${e.to}|${e.relation}`;
  if (seen.has(k)) continue;
  seen.add(k);
  deduped.push(e);
}

const graph = {
  version: 1,
  root,
  generated_at: now,
  stats: {
    total_files: rawFiles.length,
    nodes: nodes.length,
    edges: deduped.length,
    external_edges: deduped.filter(e => e.external).length,
  },
  nodes,
  edges: deduped,
  // For quick lookups
  files: Object.fromEntries(rawFiles.map(f => [escapeId(rel(f)), escapeId(rel(f))])),
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "graph.json"), JSON.stringify(graph, null, 2));

console.log(`[nexus-graph.js] Wrote ${nodes.length} nodes, ${deduped.length} edges → ${path.join(outDir, "graph.json")}`);
