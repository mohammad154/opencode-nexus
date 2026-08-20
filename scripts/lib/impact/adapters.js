/**
 * Lightweight JS/TS symbol extraction (AST-aware without native tree-sitter).
 * Unsupported languages report coverage gaps that lower confidence.
 */
const PARSER_VERSION = "nexus-js-symbols-1.0";

const JS_EXTS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);

export function languageForPath(filePath) {
  const lower = String(filePath || "").toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  if (JS_EXTS.has(ext)) return ext.startsWith(".ts") || ext === ".tsx" ? "typescript" : "javascript";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if (ext === ".java") return "java";
  return "unknown";
}

export function adapterSupports(language) {
  return language === "javascript" || language === "typescript";
}

/**
 * Extract definitions, exports, and imports from JS/TS source text.
 */
export function extractJsSymbols(source, filePath = "file.js") {
  const definitions = [];
  const exports = [];
  const imports = [];
  const references = [];

  const lines = String(source || "").split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;

    let m;
    if ((m = line.match(/^\s*export\s+(?:async\s+)?function\s+(\w+)/))) {
      definitions.push({ kind: "function", name: m[1], line: lineNo, exported: true });
      exports.push({ name: m[1], kind: "function", line: lineNo });
    } else if ((m = line.match(/^\s*(?:async\s+)?function\s+(\w+)/))) {
      definitions.push({ kind: "function", name: m[1], line: lineNo, exported: false });
    } else if ((m = line.match(/^\s*export\s+(?:default\s+)?class\s+(\w+)/))) {
      definitions.push({ kind: "class", name: m[1], line: lineNo, exported: true });
      exports.push({ name: m[1], kind: "class", line: lineNo });
    } else if ((m = line.match(/^\s*class\s+(\w+)/))) {
      definitions.push({ kind: "class", name: m[1], line: lineNo, exported: false });
    } else if ((m = line.match(/^\s*export\s+(?:const|let|var)\s+(\w+)/))) {
      definitions.push({ kind: "constant", name: m[1], line: lineNo, exported: true });
      exports.push({ name: m[1], kind: "constant", line: lineNo });
    } else if ((m = line.match(/^\s*export\s+(?:type|interface)\s+(\w+)/))) {
      definitions.push({ kind: "interface", name: m[1], line: lineNo, exported: true });
      exports.push({ name: m[1], kind: "interface", line: lineNo });
    } else if ((m = line.match(/^\s*export\s*\{([^}]+)\}/))) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) exports.push({ name, kind: "named", line: lineNo });
      }
    }

    if ((m = line.match(/^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/))) {
      imports.push({ source: m[1], line: lineNo, kind: "esm" });
    } else if ((m = line.match(/^\s*import\s+['"]([^'"]+)['"]/))) {
      imports.push({ source: m[1], line: lineNo, kind: "side-effect" });
    } else if ((m = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/))) {
      imports.push({ source: m[1], line: lineNo, kind: "cjs" });
    }
  }

  // Crude reference scan for exported names used elsewhere is done at repo level.
  return {
    file: filePath,
    language: languageForPath(filePath),
    parser_version: PARSER_VERSION,
    definitions,
    exports,
    imports,
    references,
  };
}

export function extractSymbols(source, filePath) {
  const language = languageForPath(filePath);
  if (!adapterSupports(language)) {
    return {
      file: filePath,
      language,
      parser_version: PARSER_VERSION,
      definitions: [],
      exports: [],
      imports: [],
      references: [],
      supported: false,
      coverage: 0,
    };
  }
  return { ...extractJsSymbols(source, filePath), supported: true, coverage: 1 };
}

export { PARSER_VERSION };
