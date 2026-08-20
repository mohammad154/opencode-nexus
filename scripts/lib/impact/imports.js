/**
 * Import / reference resolution for impact analysis.
 */
import fs from "fs";
import path from "path";
import { extractSymbols, languageForPath, adapterSupports } from "./adapters.js";
import {
  loadCache,
  saveCache,
  fileHash,
  getCachedSymbols,
  putCachedSymbols,
} from "./symbols.js";

function walkSourceFiles(root, { maxFiles = 5000 } = {}) {
  const out = [];
  const skip = new Set([
    "node_modules",
    ".git",
    "graphify-out",
    ".opencode",
    "dist",
    "build",
    "coverage",
  ]);

  function walk(dir) {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      if (skip.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        const rel = path.relative(root, full).replace(/\\/g, "/");
        const lang = languageForPath(rel);
        if (adapterSupports(lang) || lang !== "unknown") out.push(rel);
      }
    }
  }
  walk(root);
  return out;
}

function resolveImportPath(fromFile, spec, worktree) {
  if (!spec || spec.startsWith("node:") || (!spec.startsWith(".") && !spec.startsWith("/"))) {
    return null; // external package
  }
  const base = path.resolve(path.dirname(path.join(worktree, fromFile)), spec);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.ts`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.tsx`,
    `${base}.jsx`,
    path.join(base, "index.js"),
    path.join(base, "index.ts"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      return path.relative(worktree, c).replace(/\\/g, "/");
    }
  }
  return null;
}

export function buildImportIndex(worktree, options = {}) {
  const cache = loadCache(worktree);
  const files = options.files || walkSourceFiles(worktree);
  const byFile = {};
  let unsupported = 0;
  let parsed = 0;
  let cacheHits = 0;

  for (const rel of files) {
    const full = path.join(worktree, rel);
    if (!fs.existsSync(full)) continue;
    let content;
    try {
      content = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const hash = fileHash(content);
    let symbols = getCachedSymbols(cache, rel, hash);
    if (symbols) {
      cacheHits += 1;
    } else {
      symbols = extractSymbols(content, rel);
      putCachedSymbols(cache, rel, hash, symbols);
      parsed += 1;
    }
    if (!symbols.supported) unsupported += 1;
    byFile[rel] = symbols;
  }

  if (options.persistCache !== false) saveCache(worktree, cache);

  // Build reverse import map: file → importers
  const importers = {};
  for (const [file, symbols] of Object.entries(byFile)) {
    for (const imp of symbols.imports || []) {
      const resolved = resolveImportPath(file, imp.source, worktree);
      if (!resolved) continue;
      if (!importers[resolved]) importers[resolved] = [];
      importers[resolved].push({ from: file, line: imp.line, spec: imp.source });
    }
  }

  return { byFile, importers, stats: { parsed, cacheHits, unsupported, files: files.length } };
}

export function findSymbolReferences(index, symbolName, definitionFile) {
  const refs = [];
  const re = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  for (const [file, symbols] of Object.entries(index.byFile || {})) {
    if (file === definitionFile) continue;
    // Prefer importers of the definition file
    const importsDef = (symbols.imports || []).some((imp) => {
      // loose: any relative import might pull the symbol
      return true;
    });
    if (!importsDef && !(index.importers?.[definitionFile] || []).some((i) => i.from === file)) {
      continue;
    }
    // Check if file text would need re-read — use export usage heuristic via definitions presence
    const uses = (symbols.definitions || []).some((d) => d.name === symbolName);
    if (uses) refs.push({ file, kind: "definition-collision" });
  }
  // Also list direct importers of the file
  for (const imp of index.importers?.[definitionFile] || []) {
    refs.push({ file: imp.from, kind: "importer", line: imp.line });
  }
  return refs;
}

export { walkSourceFiles, resolveImportPath };
