/**
 * Reference / dependent discovery (Nx-style affected at file/symbol level).
 */
import { findSymbolReferences, resolveImportPath } from "./imports.js";

export function collectChangedSymbols(gitEvidence, index) {
  const changed_symbols = [];
  for (const file of gitEvidence.changed_files || []) {
    const symbols = index.byFile?.[file.path];
    if (!symbols) continue;
    for (const def of symbols.definitions || []) {
      changed_symbols.push({
        file: file.path,
        name: def.name,
        kind: def.kind,
        exported: !!def.exported,
        line: def.line,
      });
    }
    for (const exp of symbols.exports || []) {
      if (!changed_symbols.some((s) => s.file === file.path && s.name === exp.name)) {
        changed_symbols.push({
          file: file.path,
          name: exp.name,
          kind: exp.kind || "export",
          exported: true,
          line: exp.line,
        });
      }
    }
  }
  return changed_symbols;
}

export function collectDependents(gitEvidence, index, changed_symbols, worktree = null) {
  const direct = new Set();
  const transitive = new Set();

  for (const file of gitEvidence.changed_files || []) {
    const path = file.path;
    const deleted =
      String(file.status || "").startsWith("D") ||
      (worktree && file.status === "D");

    if (deleted) {
      for (const [fromFile, symbols] of Object.entries(index.byFile || {})) {
        for (const imp of symbols.imports || []) {
        const resolved = resolveImportPath(fromFile, imp.source, worktree || "", {
          allowMissing: true,
        });
          if (resolved === path) direct.add(fromFile);
        }
      }
      continue;
    }

    for (const imp of index.importers?.[path] || []) {
      direct.add(imp.from);
    }
  }

  for (const sym of changed_symbols || []) {
    if (!sym.exported) continue;
    for (const ref of findSymbolReferences(index, sym.name, sym.file)) {
      direct.add(ref.file);
    }
  }

  // One-hop transitive
  for (const file of direct) {
    for (const imp of index.importers?.[file] || []) {
      if (!direct.has(imp.from) && !(gitEvidence.changed_files || []).some((f) => f.path === imp.from)) {
        transitive.add(imp.from);
      }
    }
  }

  return {
    direct_dependents: [...direct].sort(),
    transitive_dependents: [...transitive].sort(),
  };
}
