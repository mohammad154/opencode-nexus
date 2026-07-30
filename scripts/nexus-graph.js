#!/usr/bin/env node
/**
 * nexus-graph.js — dependency graph builder with explicit freshness/quality.
 * Inputs:  argv[2]=file-list, argv[3]=root, argv[4]=outDir
 * Outputs: $outDir/graph.json
 *
 * The extractor intentionally stays dependency-light. If the optional
 * TypeScript parser is installed it is used for JS/TS; otherwise a
 * comment-aware lexer extracts only unambiguous import forms and marks the
 * graph CONSERVATIVE. Unsupported languages are indexed but do not produce
 * guessed dependency edges.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { createRequire } from "module";
import { execSync } from "child_process";

const GENERATOR_VERSION = "3.0";
const EXTRACTOR_VERSION = "3.0";
const MAX_FILE_BYTES = 512 * 1024;

const fileListPath = process.argv[2];
const root = path.resolve(process.argv[3] || process.cwd());
const outDir = path.resolve(
  process.argv[4] || path.join(root, ".opencode", "knowledge"),
);

if (!fileListPath || !fs.existsSync(fileListPath)) {
  console.error("[nexus-graph.js] file list missing:", fileListPath);
  process.exit(1);
}

const rawFiles = [...new Set(
  fs.readFileSync(fileListPath, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((file) => path.resolve(root, file)),
)];

function normalizePath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

function rel(file) {
  return normalizePath(path.relative(root, path.resolve(file))) || path.basename(file);
}

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

function digestBuffer(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestText(value) {
  return digestBuffer(Buffer.from(value, "utf8"));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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

function workingTreeFingerprint(commit, source, outputDirectory) {
  return digestText(JSON.stringify({
    head_commit: commit,
    source_fingerprint: source,
    status: statusLines(root, outputDirectory),
  }));
}

function isWithinRoot(file) {
  const relative = path.relative(root, path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function extensionCandidates(base) {
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    `${base}.py`,
    `${base}.go`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx"),
    path.join(base, "index.mjs"),
  ];
}

function tryResolveImport(imp, fromFile, knownFiles) {
  if (imp.startsWith(".") || imp.startsWith("/")) {
    const base = path.resolve(path.dirname(fromFile), imp);
    for (const candidate of extensionCandidates(base)) {
      if (!isWithinRoot(candidate) || !fs.existsSync(candidate)) continue;
      if (!fs.statSync(candidate).isFile()) continue;
      const target = normalizePath(rel(candidate));
      if (knownFiles.has(target)) return { to: target, resolved: true };
      return {
        to: target,
        resolved: false,
        external: false,
        unindexed: true,
      };
    }
    return { to: normalizePath(imp), resolved: false, external: false };
  }

  // Workspace aliases cannot be resolved without tsconfig/package metadata.
  if (imp.startsWith("@/") || imp.startsWith("~/")) {
    return { to: normalizePath(imp), resolved: false, external: false };
  }

  return { to: imp, resolved: false, external: true };
}

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events",
  "fs", "http", "http2", "https", "module", "net", "os", "path",
  "perf_hooks", "process", "punycode", "querystring", "readline", "repl",
  "stream", "string_decoder", "sys", "timers", "tls", "trace_events",
  "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

function isBuiltinModule(specifier) {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier);
}

function extractSymbols(text) {
  const lines = text.split("\n");
  const symbolPattern = /^\s*(export\s+)?(function|class|const\s+\w+\s*=|let\s+\w+\s*=|def\s+\w+|fn\s+\w+|func\s+\w+|struct\s+\w+|interface\s+\w+|type\s+\w+|enum\s+\w+)/;
  return lines.reduce((count, line) => count + (symbolPattern.test(line) ? 1 : 0), 0);
}

function makeEdge(specifier, file, knownFiles, extractor) {
  const spec = String(specifier || "").trim();
  if (!spec || isBuiltinModule(spec)) return null;
  const resolved = tryResolveImport(spec, file, knownFiles);
  const edge = {
    from: normalizePath(rel(file)),
    to: resolved.to,
    relation: "imports",
    confidence: resolved.resolved ? "EXTRACTED" : "INFERRED",
    confidence_score: resolved.resolved ? 1.0 : (resolved.external ? 0.9 : 0.75),
    source_file: normalizePath(rel(file)),
    external: !!resolved.external,
    extractor,
  };
  if (resolved.unindexed) {
    edge.uncertainty = "resolved file is outside the supplied graph file list";
  }
  return edge;
}

function readQuoted(source, start, quote) {
  let value = "";
  let index = start + 1;
  let closed = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1];
      if (next === undefined) break;
      const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };
      value += escapes[next] ?? next;
      index += 2;
      continue;
    }
    if (char === quote) {
      closed = true;
      index += 1;
      break;
    }
    if (char === "\n" || char === "\r") break;
    value += char;
    index += 1;
  }
  return { value, end: index, closed };
}

function skipRegex(source, start) {
  let index = start + 1;
  let inClass = false;
  let escaped = false;
  while (index < source.length) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      index += 1;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      index += 1;
      while (/[a-z]/i.test(source[index] || "")) index += 1;
      return { end: index, closed: true };
    } else if (char === "\n" || char === "\r") {
      return { end: index, closed: false };
    }
    index += 1;
  }
  return { end: index, closed: false };
}

function canStartRegex(previous) {
  if (!previous) return true;
  if (previous.type === "word" || previous.type === "string") {
    return ["return", "throw", "case", "delete", "void", "typeof", "yield", "await"].includes(previous.value);
  }
  return new Set(["(", "[", "{", ",", ";", ":", "=", "!", "?", "&&", "||", "=>"]).has(previous.value);
}

function tokenizeJsTs(source) {
  const tokens = [];
  const uncertainties = [];
  let index = 0;
  let previous = null;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (index === 0 && char === "#" && next === "!") {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) {
        uncertainties.push("unterminated block comment");
        break;
      }
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const quoted = readQuoted(source, index, char);
      if (!quoted.closed) uncertainties.push("unterminated string literal");
      const token = { type: "string", value: quoted.value };
      tokens.push(token);
      previous = token;
      index = quoted.end;
      continue;
    }
    if (char === "`") {
      const start = index;
      let escaped = false;
      index += 1;
      let closed = false;
      while (index < source.length) {
        const current = source[index];
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === "`") {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) uncertainties.push("unterminated template literal");
      else if (source.slice(start, index).includes("${")) {
        uncertainties.push("template literal expressions are not traversed");
      }
      continue;
    }
    if (char === "/" && next !== "/" && next !== "*" && canStartRegex(previous)) {
      const regex = skipRegex(source, index);
      if (!regex.closed) uncertainties.push("unterminated regular expression literal");
      index = regex.end;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/.test(source[end] || "")) end += 1;
      const token = { type: "word", value: source.slice(index, end) };
      tokens.push(token);
      previous = token;
      index = end;
      continue;
    }

    const punct = source.startsWith("?.", index)
      ? "?."
      : source.startsWith("=>", index)
        ? "=>"
        : source.startsWith("...", index)
          ? "..."
          : char;
    const token = { type: "punct", value: punct };
    tokens.push(token);
    previous = token;
    index += punct.length;
  }

  return { tokens, uncertainties };
}

function isDeclarationBoundary(tokens, index) {
  const previous = tokens[index - 1];
  return !previous || [";", "}", "{"].includes(previous.value);
}

function lexicalJsTsEdges(text, file, knownFiles) {
  const { tokens, uncertainties } = tokenizeJsTs(text);
  const specs = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "word") continue;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];

    if (token.value === "require" && previous?.value !== "." && next?.value === "(") {
      const argument = tokens[index + 2];
      if (argument?.type === "string") specs.push(argument.value);
      continue;
    }

    if (token.value === "import" && previous?.value !== ".") {
      if (next?.value === "(") {
        const argument = tokens[index + 2];
        if (argument?.type === "string") specs.push(argument.value);
        continue;
      }
      if (!isDeclarationBoundary(tokens, index)) continue;
      if (
        !next ||
        (next.type !== "string" &&
          next.type !== "word" &&
          !["*", "{"].includes(next.value))
      ) continue;
      if (next?.type === "string") {
        specs.push(next.value);
        continue;
      }
      for (let cursor = index + 1; cursor < Math.min(tokens.length, index + 100); cursor += 1) {
        if ([";", "import", "export"].includes(tokens[cursor].value)) break;
        if (tokens[cursor].type === "word" && tokens[cursor].value === "from") {
          if (tokens[cursor + 1]?.type === "string") specs.push(tokens[cursor + 1].value);
          break;
        }
      }
      continue;
    }

    if (token.value === "export" && isDeclarationBoundary(tokens, index)) {
      const nextValue = next?.value;
      if (!["*", "{", "type"].includes(nextValue)) continue;
      for (let cursor = index + 1; cursor < Math.min(tokens.length, index + 100); cursor += 1) {
        if ([";", "import", "export"].includes(tokens[cursor].value)) break;
        if (tokens[cursor].type === "word" && tokens[cursor].value === "from") {
          if (tokens[cursor + 1]?.type === "string") specs.push(tokens[cursor + 1].value);
          break;
        }
      }
    }
  }

  return {
    edges: specs
      .map((specifier) => makeEdge(specifier, file, knownFiles, "comment-aware-lexer"))
      .filter(Boolean),
    quality: "CONSERVATIVE",
    uncertainties: [
      "JavaScript/TypeScript imports extracted with a comment-aware lexer; optional AST parser unavailable",
      ...uncertainties,
    ],
  };
}

let typescriptParser = null;
try {
  typescriptParser = createRequire(import.meta.url)("typescript");
} catch {
  // Optional dependency: the lexical extractor remains the safe fallback.
}

function typescriptScriptKind(lang) {
  if (!typescriptParser) return undefined;
  if (lang === "typescript") return typescriptParser.ScriptKind.TSX;
  return typescriptParser.ScriptKind.JSX;
}

function astJsTsEdges(text, file, lang, knownFiles) {
  const ts = typescriptParser;
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    typescriptScriptKind(lang),
  );
  const diagnostics = sourceFile.parseDiagnostics || [];
  const specs = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteral(expression)) specs.push(expression.text);
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const first = node.arguments[0];
      if (
        expression.kind === ts.SyntaxKind.ImportKeyword &&
        first &&
        ts.isStringLiteral(first)
      ) {
        specs.push(first.text);
      } else if (
        ts.isIdentifier(expression) &&
        expression.text === "require" &&
        first &&
        ts.isStringLiteral(first)
      ) {
        specs.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const quality = diagnostics.length > 0 ? "CONSERVATIVE" : "PRECISE";
  return {
    edges: specs
      .map((specifier) => makeEdge(specifier, file, knownFiles, "typescript-ast"))
      .filter(Boolean),
    quality,
    uncertainties: diagnostics.length > 0
      ? [`TypeScript parser reported ${diagnostics.length} syntax diagnostic(s)`]
      : [],
  };
}

const RE_PY_FROM = /^\s*from\s+([a-zA-Z0-9_.]+)\s+import\s+/gm;
const RE_PY_IMPORT = /^\s*import\s+([a-zA-Z0-9_.,\s]+)/gm;
const RE_GO_IMPORT_BLOCK = /import\s*\(\s*([^)]+)\)/gms;

function extractEdges(text, file, lang, knownFiles) {
  if (lang === "javascript" || lang === "typescript") {
    if (typescriptParser) {
      try {
        const ast = astJsTsEdges(text, file, lang, knownFiles);
        if (ast.quality === "PRECISE") return ast;
      } catch (error) {
        return {
          ...lexicalJsTsEdges(text, file, knownFiles),
          uncertainties: [
            "TypeScript parser failed; lexical fallback used",
            String(error.message || error),
          ],
        };
      }
    }
    return lexicalJsTsEdges(text, file, knownFiles);
  }

  const edges = [];
  const push = (specifier) => {
    const edge = makeEdge(specifier, file, knownFiles, "conservative-regex");
    if (edge) edges.push(edge);
  };

  if (lang === "python") {
    let match;
    while ((match = RE_PY_FROM.exec(text)) !== null) push(match[1].replace(/\./g, "/"));
    RE_PY_FROM.lastIndex = 0;
    while ((match = RE_PY_IMPORT.exec(text)) !== null) {
      for (const part of match[1].split(",")) {
        push(part.trim().split(/\s+as\s+/)[0].replace(/\./g, "/"));
      }
    }
    RE_PY_IMPORT.lastIndex = 0;
    return {
      edges,
      quality: "CONSERVATIVE",
      uncertainties: ["Python imports use conservative line matching; string/docstring analysis is unsupported"],
    };
  }

  if (lang === "go") {
    const single = text.match(/^\s*import\s+"([^"]+)"/gm) || [];
    for (const line of single) {
      const match = line.match(/"([^"]+)"/);
      if (match) push(match[1]);
    }
    let match;
    while ((match = RE_GO_IMPORT_BLOCK.exec(text)) !== null) {
      const lineRe = /"([^"]+)"/g;
      let lineMatch;
      while ((lineMatch = lineRe.exec(match[1])) !== null) push(lineMatch[1]);
    }
    RE_GO_IMPORT_BLOCK.lastIndex = 0;
    return {
      edges,
      quality: "CONSERVATIVE",
      uncertainties: ["Go imports use conservative regex matching; comment/string edge cases are unsupported"],
    };
  }

  return {
    edges: [],
    quality: "UNSUPPORTED",
    uncertainties: [`Dependency extraction unsupported for ${lang} files`],
  };
}

function qualityRank(quality) {
  return { PRECISE: 2, CONSERVATIVE: 1, UNSUPPORTED: 0 }[quality] ?? 0;
}

function graphQuality(nodes, edges) {
  if (nodes.length === 0) return "UNKNOWN";
  const supportedDependencyLanguages = new Set([
    "javascript",
    "typescript",
    "python",
    "go",
  ]);
  const dependencyNodes = nodes.filter(
    (node) => supportedDependencyLanguages.has(node.lang),
  );
  if (dependencyNodes.length === 0) return "UNSUPPORTED";
  let quality = "PRECISE";
  for (const node of dependencyNodes) {
    const nodeQuality = node.analysis_quality || "UNSUPPORTED";
    if (qualityRank(nodeQuality) < qualityRank(quality)) quality = nodeQuality;
  }
  const unresolvedLocal = edges.some((edge) => edge.confidence === "INFERRED" && !edge.external);
  if (unresolvedLocal && quality === "PRECISE") quality = "CONSERVATIVE";
  return quality;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

const knownFiles = new Set(rawFiles.map((file) => normalizePath(rel(file))));
const previousGraph = readJson(path.join(outDir, "graph.json"));
const previousNodes = new Map(
  (previousGraph?.nodes || []).map((node) => [normalizePath(node.id || node.path), node]),
);
const previousEdges = new Map();
for (const edge of previousGraph?.edges || []) {
  const from = normalizePath(edge.from || "");
  if (!previousEdges.has(from)) previousEdges.set(from, []);
  previousEdges.get(from).push(edge);
}
const cacheCompatible =
  process.env.NEXUS_GRAPH_FORCE !== "1" &&
  previousGraph?.generator_version === GENERATOR_VERSION &&
  normalizePath(previousGraph?.root || "") === normalizePath(root);

const nodes = [];
const allEdges = [];
const sourceRecords = [];
const graphUncertainties = [];
const qualityCounts = { PRECISE: 0, CONSERVATIVE: 0, UNSUPPORTED: 0 };
let reusedNodes = 0;
let rebuiltNodes = 0;
let reusedEdges = 0;

for (const file of rawFiles) {
  const id = normalizePath(rel(file));
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (error) {
    sourceRecords.push({ path: id, file_hash: null });
    const node = {
      id,
      label: path.basename(file),
      path: id,
      lang: langOf(file),
      type: "file",
      symbol_count: 0,
      evidence: `${id}:1`,
      file_hash: null,
      analysis_quality: "UNSUPPORTED",
      analysis_uncertainties: [`file could not be read: ${error.message}`],
    };
    nodes.push(node);
    qualityCounts.UNSUPPORTED += 1;
    graphUncertainties.push(`${id} could not be read; graph freshness will be unverifiable`);
    rebuiltNodes += 1;
    continue;
  }

  const fileHash = digestBuffer(buffer);
  sourceRecords.push({ path: id, file_hash: fileHash });
  const previousNode = previousNodes.get(id);
  const cached =
    cacheCompatible &&
    previousNode?.file_hash === fileHash &&
    previousNode?.analysis_version === EXTRACTOR_VERSION;

  if (cached) {
    const node = { ...previousNode, file_hash: fileHash };
    const cachedEdges = previousEdges.get(id) || [];
    nodes.push(node);
    for (const edge of cachedEdges) allEdges.push(edge);
    qualityCounts[node.analysis_quality] = (qualityCounts[node.analysis_quality] || 0) + 1;
    reusedNodes += 1;
    reusedEdges += cachedEdges.length;
    continue;
  }

  const text = buffer.toString("utf8");
  const lang = langOf(file);
  let extraction;
  if (buffer.byteLength > MAX_FILE_BYTES) {
    extraction = {
      edges: [],
      quality: "UNSUPPORTED",
      uncertainties: [`file exceeds ${MAX_FILE_BYTES} bytes; dependency extraction skipped`],
    };
  } else {
    extraction = extractEdges(text, file, lang, knownFiles);
  }

  const node = {
    id,
    label: path.basename(file),
    path: id,
    lang,
    type: "file",
    symbol_count: extractSymbols(text),
    evidence: `${id}:1`,
    size_bytes: buffer.byteLength,
    file_hash: fileHash,
    analysis_version: EXTRACTOR_VERSION,
    analysis_quality: extraction.quality,
  };
  if (extraction.uncertainties.length > 0) {
    node.analysis_uncertainties = uniqueStrings(extraction.uncertainties);
    graphUncertainties.push(...node.analysis_uncertainties.map((item) => `${id}: ${item}`));
  }
  nodes.push(node);
  allEdges.push(...extraction.edges);
  qualityCounts[extraction.quality] = (qualityCounts[extraction.quality] || 0) + 1;
  rebuiltNodes += 1;
}

const seen = new Set();
const deduped = [];
for (const edge of allEdges) {
  const key = `${edge.from}|${edge.to}|${edge.relation}`;
  if (seen.has(key)) continue;
  seen.add(key);
  deduped.push(edge);
}

const generatedAtCommit = headCommit(root);
const source = sourceFingerprint(sourceRecords);
const quality = graphQuality(nodes, deduped);
const inferredLocalEdges = deduped.filter(
  (edge) => edge.confidence === "INFERRED" && !edge.external,
).length;
const externalEdges = deduped.filter((edge) => edge.external).length;

if (inferredLocalEdges > 0) {
  graphUncertainties.push(
    `${inferredLocalEdges} local import edge(s) were unresolved or alias-based and are INFERRED`,
  );
}
if (externalEdges > 0) {
  graphUncertainties.push(
    `${externalEdges} external import edge(s) are recorded but excluded from local blast traversal`,
  );
}

const graph = {
  version: 2,
  root,
  generated_at: new Date().toISOString(),
  generated_at_commit: generatedAtCommit,
  generator_version: GENERATOR_VERSION,
  source_fingerprint: source,
  working_tree_fingerprint: workingTreeFingerprint(generatedAtCommit, source, outDir),
  output_dir: normalizePath(path.relative(root, outDir)),
  extractor_quality: quality,
  extractor: {
    name: typescriptParser ? "typescript-ast-with-lexical-fallback" : "comment-aware-lexical",
    version: EXTRACTOR_VERSION,
    quality,
    cache_strategy: "file-content",
  },
  freshness: {
    head_commit: generatedAtCommit,
    generator_version: GENERATOR_VERSION,
    source_fingerprint: source,
    working_tree_fingerprint: workingTreeFingerprint(generatedAtCommit, source, outDir),
  },
  quality_summary: qualityCounts,
  uncertainties: uniqueStrings(graphUncertainties),
  cache: {
    strategy: "file-content",
    reused_nodes: reusedNodes,
    rebuilt_nodes: rebuiltNodes,
    reused_edges: reusedEdges,
  },
  stats: {
    total_files: rawFiles.length,
    nodes: nodes.length,
    edges: deduped.length,
    external_edges: externalEdges,
    inferred_local_edges: inferredLocalEdges,
  },
  nodes,
  edges: deduped,
  files: Object.fromEntries(rawFiles.map((file) => [normalizePath(rel(file)), normalizePath(rel(file))])),
};

fs.mkdirSync(outDir, { recursive: true });
const graphPath = path.join(outDir, "graph.json");
const temporaryGraphPath = `${graphPath}.tmp`;
fs.writeFileSync(temporaryGraphPath, JSON.stringify(graph, null, 2));
fs.renameSync(temporaryGraphPath, graphPath);

console.log(
  `[nexus-graph.js] Wrote ${nodes.length} nodes, ${deduped.length} edges → ${graphPath} (quality=${quality}, reused=${reusedNodes})`,
);
