/**
 * Incremental impact cache keyed by file hash + parser version.
 */
import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import { PARSER_VERSION } from "./adapters.js";

function cacheDir(worktree) {
  return path.join(worktree, ".opencode", "cache", "impact");
}

function ensureCache(worktree) {
  const dir = cacheDir(worktree);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function fileHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function loadCache(worktree) {
  const dir = ensureCache(worktree);
  const read = (name) => {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) return {};
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return {};
    }
  };
  return {
    files: read("files.json"),
    symbols: read("symbols.json"),
    imports: read("imports.json"),
  };
}

export function saveCache(worktree, cache) {
  const dir = ensureCache(worktree);
  fs.writeFileSync(path.join(dir, "files.json"), JSON.stringify(cache.files || {}, null, 2));
  fs.writeFileSync(path.join(dir, "symbols.json"), JSON.stringify(cache.symbols || {}, null, 2));
  fs.writeFileSync(path.join(dir, "imports.json"), JSON.stringify(cache.imports || {}, null, 2));
}

export function getCachedSymbols(cache, filePath, hash) {
  const entry = cache.symbols?.[filePath];
  if (
    entry &&
    entry.hash === hash &&
    entry.parser_version === PARSER_VERSION
  ) {
    return entry.symbols;
  }
  return null;
}

export function putCachedSymbols(cache, filePath, hash, symbols) {
  cache.symbols = cache.symbols || {};
  cache.files = cache.files || {};
  cache.imports = cache.imports || {};
  cache.symbols[filePath] = {
    hash,
    parser_version: PARSER_VERSION,
    language: symbols.language,
    symbols,
  };
  cache.files[filePath] = { hash, language: symbols.language };
  cache.imports[filePath] = {
    hash,
    imports: symbols.imports || [],
  };
}
