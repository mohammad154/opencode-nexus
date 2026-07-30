import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const TEST_FILE_RE =
  /(^|\/)(?:tests?|__tests__)(\/|$)|(?:\.test|\.spec)\.[^/]+$/i;
const PROFILE_EVIDENCE_KEYS = [
  "filesChanged",
  "files_changed",
  "estimatedLines",
  "estimated_lines",
  "exportedSymbolChange",
  "exported_symbol_change",
  "crossPackageChange",
  "cross_package_change",
];

function runGit(cwd, args) {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.stderr || error?.message || error),
    };
  }
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function relativePath(root, value) {
  const rel = normalizePath(path.relative(root, value));
  return rel || ".";
}

function parseGitPath(value) {
  if (!value || value === "/dev/null") return null;
  const tab = value.indexOf("\t");
  const raw = (tab === -1 ? value : value.slice(0, tab)).trim();
  if (raw === "/dev/null") return null;
  if (raw.startsWith("a/") || raw.startsWith("b/")) return normalizePath(raw.slice(2));
  return normalizePath(raw);
}

function patchPath(value) {
  const raw = value.replace(/^--- |^\+\+\+ /, "").trim();
  return parseGitPath(raw.split("\t")[0]);
}

function extractExportedSymbols(line) {
  const text = line.replace(/^\+|-/, "").trim();
  const symbols = [];
  let match = text.match(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  );
  if (match) symbols.push(match[1]);

  match = text.match(/^export\s+default\s+(?:async\s+)?(?:function|class)\s*([A-Za-z_$][\w$]*)?/);
  if (match) symbols.push(match[1] || "default");

  match = text.match(/^export\s*\{([^}]+)\}/);
  if (match) {
    for (const item of match[1].split(",")) {
      const name = item.trim().split(/\s+as\s+/i)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) symbols.push(name);
    }
  }

  match = text.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)/);
  if (match) symbols.push(match[1]);

  return symbols;
}

function ensurePatchFile(files, file) {
  if (!file) return null;
  if (!files.has(file)) {
    files.set(file, {
      added_lines: 0,
      deleted_lines: 0,
      exported_symbols: new Set(),
    });
  }
  return files.get(file);
}

function parsePatch(patch, files) {
  let oldPath = null;
  let newPath = null;
  let currentFile = null;

  for (const line of String(patch || "").split(/\r?\n/)) {
    if (line.startsWith("--- ")) {
      oldPath = patchPath(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = patchPath(line);
      currentFile = newPath || oldPath;
      ensurePatchFile(files, currentFile);
      continue;
    }
    if (!currentFile) continue;
    const entry = ensurePatchFile(files, currentFile);
    if (line.startsWith("+") && !line.startsWith("+++")) {
      entry.added_lines += 1;
      for (const symbol of extractExportedSymbols(line)) {
        entry.exported_symbols.add(symbol);
      }
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      entry.deleted_lines += 1;
      for (const symbol of extractExportedSymbols(line)) {
        entry.exported_symbols.add(symbol);
      }
    }
  }
}

function lineCount(text) {
  if (!text) return 0;
  const lines = String(text).split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function exportedSymbolsFromText(text) {
  const symbols = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    for (const symbol of extractExportedSymbols(line)) symbols.add(symbol);
  }
  return symbols;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function nearestPackage(root, file) {
  let current = path.resolve(root, path.dirname(file));
  const rootPath = path.resolve(root);
  while (current === rootPath || current.startsWith(`${rootPath}${path.sep}`)) {
    const manifestPath = path.join(current, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = readJson(manifestPath) || {};
      return {
        path: relativePath(rootPath, current),
        name: typeof manifest.name === "string" ? manifest.name : null,
        package_json: relativePath(rootPath, manifestPath),
      };
    }
    if (current === rootPath) break;
    current = path.dirname(current);
  }
  return null;
}

function workspacePatterns(root) {
  const manifest = readJson(path.join(root, "package.json"));
  const workspaces = manifest?.workspaces;
  if (Array.isArray(workspaces)) return workspaces;
  if (workspaces && Array.isArray(workspaces.packages)) return workspaces.packages;
  return [];
}

function workspaceDirectories(root, patterns) {
  const directories = new Set();
  for (const rawPattern of patterns) {
    const pattern = normalizePath(rawPattern).replace(/\/$/, "");
    if (!pattern) continue;
    const wildcard = pattern.search(/[*!?]/);
    if (wildcard === -1) {
      directories.add(pattern);
      continue;
    }

    const prefix = pattern.slice(0, wildcard).replace(/\/$/, "");
    const base = path.join(root, prefix);
    if (!fs.existsSync(base)) continue;
    const entries = fs.readdirSync(base, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) directories.add(normalizePath(path.join(prefix, entry.name)));
    }
  }
  return [...directories].sort();
}

function boundaryForFile(file, boundaries) {
  const matches = boundaries.filter(
    (boundary) => file === boundary || file.startsWith(`${boundary}/`),
  );
  return matches.sort((a, b) => b.length - a.length)[0] || null;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function diffCommandSets(base, hasHead) {
  const common = ["diff", "--no-ext-diff", "--no-renames", "--unified=0"];
  if (base) return [[...common, base, "--"]];
  if (hasHead) return [[...common, "HEAD", "--"]];
  return [
    [...common, "--cached", "--"],
    [...common, "--"],
  ];
}

function withNameOnly(command) {
  return [command[0], "--name-only", "-z", ...command.slice(1)];
}

function withUntracked(root, files, patchFiles, warnings) {
  const result = runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!result.ok) {
    warnings.push("Unable to inspect untracked files with git");
    return;
  }
  for (const file of result.stdout.split("\0").filter(Boolean).map(normalizePath)) {
    files.add(file);
    const absolute = path.join(root, file);
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(absolute, "utf8");
      const entry = ensurePatchFile(patchFiles, file);
      entry.added_lines += lineCount(content);
      for (const symbol of exportedSymbolsFromText(content)) {
        entry.exported_symbols.add(symbol);
      }
    } catch {
      warnings.push(`Unable to read untracked file: ${file}`);
    }
  }
}

/**
 * Collect deterministic classification evidence from the current git diff.
 * The result is deliberately flat so it can be passed to classify() or stored
 * in a run artifact without any model-generated estimates.
 */
export function collectGitDiffEvidence(options = {}) {
  const requestedBase = options.base == null ? null : String(options.base);
  if (requestedBase?.startsWith("-")) {
    throw new Error("git diff base must not start with '-'");
  }

  const requestedCwd = path.resolve(options.cwd || process.cwd());
  const rootResult = runGit(requestedCwd, ["rev-parse", "--show-toplevel"]);
  const root = rootResult.ok
    ? path.resolve(rootResult.stdout.trim())
    : requestedCwd;
  const warnings = [];
  const files = new Set();
  const patchFiles = new Map();

  if (!rootResult.ok) {
    warnings.push("git repository unavailable; explicit input can only be a compatibility fallback");
    return {
      schema_version: "1.0",
      evidence_source: "git-diff",
      diff_available: false,
      diff_clean: false,
      diff_base: requestedBase,
      changed_files: [],
      files_changed: 0,
      added_lines: 0,
      deleted_lines: 0,
      changed_lines: 0,
      estimated_lines: 0,
      changed_exported_symbols: [],
      exported_symbol_change: false,
      changed_test_files: [],
      test_files: [],
      package_boundaries: [],
      workspace_boundaries: [],
      cross_package_change: false,
      warnings,
    };
  }

  const headResult = runGit(root, ["rev-parse", "--verify", "HEAD"]);
  const commands = diffCommandSets(requestedBase, headResult.ok);
  let commandFailure = false;
  for (const command of commands) {
    const names = runGit(root, withNameOnly(command));
    if (names.ok) {
      for (const file of names.stdout.split("\0").filter(Boolean).map(normalizePath)) {
        files.add(file);
      }
    } else {
      commandFailure = true;
      warnings.push(`git diff failed: ${names.error.trim().split(/\r?\n/)[0]}`);
    }

    const patch = runGit(root, command);
    if (patch.ok) parsePatch(patch.stdout, patchFiles);
    else commandFailure = true;
  }

  for (const file of patchFiles.keys()) files.add(file);
  withUntracked(root, files, patchFiles, warnings);

  const changedFiles = uniqueSorted([...files]);
  const changedExportedSymbols = uniqueSorted(
    [...patchFiles.values()].flatMap((entry) => [...entry.exported_symbols]),
  );
  const addedLines = [...patchFiles.values()].reduce(
    (sum, entry) => sum + entry.added_lines,
    0,
  );
  const deletedLines = [...patchFiles.values()].reduce(
    (sum, entry) => sum + entry.deleted_lines,
    0,
  );
  const changedTestFiles = changedFiles.filter((file) => TEST_FILE_RE.test(file));
  const packageDetails = changedFiles
    .map((file) => nearestPackage(root, file))
    .filter(Boolean);
  const packageBoundaries = uniqueSorted(packageDetails.map((entry) => entry.path));
  const workspaceRoots = workspaceDirectories(root, workspacePatterns(root));
  const workspaceBoundaries = uniqueSorted(
    changedFiles.map((file) => boundaryForFile(file, workspaceRoots)),
  );

  const diffAvailable = !commandFailure;
  return {
    schema_version: "1.0",
    evidence_source: "git-diff",
    diff_available: diffAvailable,
    diff_clean: diffAvailable && changedFiles.length === 0,
    diff_base: requestedBase || (headResult.ok ? "HEAD" : null),
    changed_files: changedFiles,
    files_changed: changedFiles.length,
    added_lines: addedLines,
    deleted_lines: deletedLines,
    changed_lines: addedLines + deletedLines,
    estimated_lines: addedLines + deletedLines,
    changed_exported_symbols: changedExportedSymbols,
    exported_symbol_change: changedExportedSymbols.length > 0,
    changed_test_files: changedTestFiles,
    test_files: changedTestFiles,
    package_boundaries: packageBoundaries,
    workspace_boundaries: workspaceBoundaries,
    cross_package_change: packageBoundaries.length > 1,
    cross_workspace_change: workspaceBoundaries.length > 1,
    package_details: packageDetails,
    warnings,
  };
}

/**
 * Merge diff evidence into legacy classifier input. Diff values are
 * authoritative when available; old numeric/boolean values are retained only
 * under compatibility_input for callers that still send them.
 */
export function mergeGitDiffEvidence(input = {}, evidence = {}) {
  const explicit = {};
  for (const key of PROFILE_EVIDENCE_KEYS) {
    if (input[key] !== undefined) explicit[key] = input[key];
  }

  if (evidence.diff_available) {
    return {
      ...input,
      filesChanged: evidence.files_changed,
      estimatedLines: evidence.estimated_lines,
      changed_files: evidence.changed_files,
      added_lines: evidence.added_lines,
      deleted_lines: evidence.deleted_lines,
      changed_lines: evidence.changed_lines,
      changed_exported_symbols: evidence.changed_exported_symbols,
      exported_symbol_change: evidence.exported_symbol_change,
      changed_test_files: evidence.changed_test_files,
      test_files: evidence.test_files,
      package_boundaries: evidence.package_boundaries,
      workspace_boundaries: evidence.workspace_boundaries,
      cross_package_change: evidence.cross_package_change,
      cross_workspace_change: evidence.cross_workspace_change,
      evidence_source: "git-diff",
      diff_requested: true,
      diff_available: true,
      diff_clean: evidence.diff_clean,
      diff_base: evidence.diff_base,
      evidence_warnings: evidence.warnings || [],
      ...(Object.keys(explicit).length ? { compatibility_input: explicit } : {}),
    };
  }

  return {
    ...input,
    evidence_source: "explicit-input-fallback",
    diff_requested: true,
    diff_available: false,
    diff_clean: false,
    diff_base: evidence.diff_base,
    evidence_warnings: evidence.warnings || [],
    ...(Object.keys(explicit).length ? { compatibility_input: explicit } : {}),
  };
}

