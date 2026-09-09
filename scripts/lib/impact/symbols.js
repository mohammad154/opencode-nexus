/**
 * Incremental impact cache keyed by file hash + parser version.
 */
import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import { PARSER_VERSION } from "./adapters.js";
import { PATH_FILTER_VERSION } from "../path-filter.js";

export const IMPACT_CACHE_VERSION = "2";

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
    if (!fs.existsSync(p)) return { value: {}, present: false, invalid: false };
    try {
      return {
        value: JSON.parse(fs.readFileSync(p, "utf8")),
        present: true,
        invalid: false,
      };
    } catch {
      return { value: {}, present: true, invalid: true };
    }
  };
  const files = read("files.json");
  const symbols = read("symbols.json");
  const imports = read("imports.json");
  const meta = read("meta.json");
  const hasLegacyCache = files.present || symbols.present || imports.present;
  const validMeta =
    files.present &&
    symbols.present &&
    imports.present &&
    !files.invalid &&
    !symbols.invalid &&
    !imports.invalid &&
    !meta.invalid &&
    meta.present &&
    meta.value?.cache_version === IMPACT_CACHE_VERSION &&
    meta.value?.parser_version === PARSER_VERSION &&
    meta.value?.path_filter_version === PATH_FILTER_VERSION;
  const cache_invalidated = hasLegacyCache && !validMeta;

  if (cache_invalidated) {
    return {
      files: {},
      symbols: {},
      imports: {},
      meta: {},
      cache_invalidated: true,
      cache_invalidation_reason: meta.invalid
        ? "invalid_metadata"
        : meta.present
        ? "version_mismatch"
        : "missing_metadata",
    };
  }

  return {
    files: files.value,
    symbols: symbols.value,
    imports: imports.value,
    meta: meta.value,
    cache_invalidated: false,
  };
}

export function saveCache(worktree, cache) {
  const dir = ensureCache(worktree);
  fs.writeFileSync(path.join(dir, "files.json"), JSON.stringify(cache.files || {}, null, 2));
  fs.writeFileSync(path.join(dir, "symbols.json"), JSON.stringify(cache.symbols || {}, null, 2));
  fs.writeFileSync(path.join(dir, "imports.json"), JSON.stringify(cache.imports || {}, null, 2));
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify(
      {
        cache_version: IMPACT_CACHE_VERSION,
        parser_version: PARSER_VERSION,
        path_filter_version: PATH_FILTER_VERSION,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/** Remove entries for paths that are no longer part of the filtered index. */
export function pruneCache(cache, activeFiles = []) {
  const active = new Set(activeFiles);
  for (const bucket of ["files", "symbols", "imports"]) {
    for (const key of Object.keys(cache[bucket] || {})) {
      if (!active.has(key)) delete cache[bucket][key];
    }
  }
  return cache;
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
