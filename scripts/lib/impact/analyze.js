/**
 * Nexus Impact Engine — on-demand evidence (git + AST + imports + tests + risk/confidence).
 */
import { collectGitEvidence } from "./git.js";
import { buildImportIndex } from "./imports.js";
import { collectChangedSymbols, collectDependents } from "./references.js";
import { discoverRelatedTests, discoverAffectedPackages } from "./tests.js";
import { computeConfidence, verificationModeForConfidence } from "./confidence.js";
import { computeRisk } from "./risk.js";
import { languageForPath, adapterSupports } from "./adapters.js";

export function analyzeImpact(worktree, options = {}) {
  const git = collectGitEvidence(worktree, {
    base: options.base || "HEAD",
  });
  if (!git.ok) {
    return {
      ok: false,
      schema_version: "1.0",
      error: git.error || "git evidence failed",
      risk: "UNKNOWN",
      confidence: 0,
      trusted: false,
      analysis_quality: "UNKNOWN",
      analysis_complete: false,
    };
  }

  const changedPaths = (git.changed_files || []).map((f) => f.path);
  const index = buildImportIndex(worktree, {
    // Index changed files + a bounded walk for importers
    persistCache: options.persistCache !== false,
  });

  const changed_symbols = collectChangedSymbols(git, index);
  const { direct_dependents, transitive_dependents } = collectDependents(
    git,
    index,
    changed_symbols,
  );
  const related_tests = discoverRelatedTests(worktree, {
    changed_files: git.changed_files,
    direct_dependents,
  });
  const affected_packages = discoverAffectedPackages(worktree, git.changed_files);

  let unsupportedFiles = 0;
  for (const p of changedPaths) {
    const lang = languageForPath(p);
    if (!adapterSupports(lang) && lang !== "unknown") unsupportedFiles += 1;
    // unknown extension (md, json) does not count as unsupported AST failure
    if (!adapterSupports(lang) && [".py", ".go", ".rs", ".java"].some((e) => p.endsWith(e))) {
      unsupportedFiles += 1;
    }
  }

  const confidence = computeConfidence({
    gitOk: true,
    unsupportedFiles,
    totalFiles: Math.max(1, changedPaths.length),
    hasDiff: changedPaths.length > 0,
    cacheComplete: true,
    parseErrors: index.stats?.unsupported || 0,
  });

  const missing_tests =
    changedPaths.some((p) => /\.(js|ts|mjs|cjs)$/.test(p) && !p.includes("test")) &&
    related_tests.length === 0;

  const riskInfo = computeRisk({
    changed_files: git.changed_files,
    changed_symbols,
    direct_dependents,
    confidence,
    change_class: options.change_class || options.changeClass,
    missing_tests,
    added_lines: git.added_lines,
    deleted_lines: git.deleted_lines,
  });

  const verification_mode = verificationModeForConfidence(confidence);

  return {
    ok: true,
    schema_version: "1.0",
    provider: "nexus-impact",
    graph_provider: "nexus-impact", // compat for policy helpers during migration
    base_commit: git.base_commit,
    head_commit: git.head_commit,
    worktree_head: git.head_commit,
    changed_files: git.changed_files,
    added_lines: git.added_lines,
    deleted_lines: git.deleted_lines,
    changed_symbols,
    direct_dependents,
    transitive_dependents,
    affected_packages,
    related_tests,
    risk: riskInfo.risk,
    level: riskInfo.risk,
    computed_risk: riskInfo.risk,
    risk_signals: riskInfo.signals,
    confidence,
    verification_mode,
    trusted: confidence >= 0.75 && riskInfo.risk !== "UNKNOWN",
    analysis_quality: unsupportedFiles > 0 ? "CONSERVATIVE" : "PRECISE",
    graph_quality: unsupportedFiles > 0 ? "CONSERVATIVE" : "PRECISE",
    analysis_complete: true,
    graph_freshness: { valid: true, current_head: git.head_commit },
    uncertainties: unsupportedFiles > 0 ? ["unsupported_language_coverage"] : [],
    dimensions: {
      symbols: changed_symbols.length,
      dependents: direct_dependents.length,
      tests: related_tests.length,
    },
    index_stats: index.stats,
    placeholder_fields: [],
  };
}

export { collectGitEvidence };
