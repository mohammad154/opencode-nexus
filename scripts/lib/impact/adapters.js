/**
 * Lightweight JS/TS symbol extraction.
 * Regex-based with multiline import/export folding. Tree-sitter is not a
 * runtime dependency; unsupported syntax lowers coverage rather than inventing symbols.
 */
const PARSER_VERSION = "nexus-js-symbols-1.1";

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

  const folded = [];
  let buf = "";
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (
      buf ||
      /^\s*(import\s|export\s+\*\s+from|export\s+\{)/.test(raw)
    ) {
      buf = buf ? `${buf} ${trimmed}` : raw;
      if (trimmed.endsWith(";") || trimmed.endsWith(";") || /;/.test(trimmed)) {
        folded.push({ line: i + 1 - (buf.split(" ").length > 20 ? 0 : 0), text: buf });
        buf = "";
      }
      continue;
    }
    folded.push({ line: i + 1, text: raw });
  }
  if (buf) folded.push({ line: lines.length, text: buf });

  for (const { line: lineNo, text: line } of folded) {
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
    } else if ((m = line.match(/^\s*export\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]/))) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) exports.push({ name, kind: "reexport", line: lineNo });
      }
      imports.push({ source: m[2], line: lineNo, kind: "reexport" });
    } else if ((m = line.match(/^\s*export\s*\*\s*from\s+['"]([^'"]+)['"]/))) {
      imports.push({ source: m[1], line: lineNo, kind: "star-reexport" });
    } else if ((m = line.match(/^\s*export\s*\{([^}]+)\}/))) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) exports.push({ name, kind: "named", line: lineNo });
      }
    } else if ((m = line.match(/^\s+(\w+)\s*\([^;]*\)\s*\{/))) {
      if (!["if", "for", "while", "switch", "catch"].includes(m[1])) {
        definitions.push({ kind: "method", name: m[1], line: lineNo, exported: false });
      }
    }

    if ((m = line.match(/import\s+.*?\s+from\s+['"]([^'"]+)['"]/))) {
      imports.push({ source: m[1], line: lineNo, kind: "esm" });
    } else if ((m = line.match(/import\s+['"]([^'"]+)['"]/))) {
      imports.push({ source: m[1], line: lineNo, kind: "side-effect" });
    }
    if ((m = line.match(/import\(\s*['"]([^'"]+)['"]\s*\)/))) {
      imports.push({ source: m[1], line: lineNo, kind: "dynamic" });
    }
    if ((m = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/))) {
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
