/**
 * Direct-mode orchestrator edits are at most 20 lines and must stay inside
 * the worktree. Control-plane paths stay writable so the orchestrator can
 * persist its own state. Protected implementer paths cannot be escaped with
 * `..` once the path is resolved.
 */
import path from "node:path";
import { validateContainedPath } from "./filesystem-boundary.js";
import { isDirectFastPath, DIRECT_EDIT_LINE_LIMIT } from "./fast-path.js";

const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "apply_patch",
  "multiedit",
  "strreplace",
]);

const IMPLEMENTER_PROTECTED = [
  ".opencode/runs",
  ".opencode/config",
  ".opencode/impact",
  ".opencode/reviews",
  ".opencode/reconcile",
  ".opencode/cache",
  ".opencode/active-run",
  ".opencode/CONTEXT.md",
  ".opencode/plans",
  ".opencode/tasks",
  ".opencode/nexus.json",
];

export function editToolName(input = {}) {
  return String(input.tool || input.name || "").trim().toLowerCase();
}

export function editFilePath(args = {}) {
  return args.filePath || args.file_path || args.path || args.file || null;
}

export function editLineCount(args = {}) {
  const hasPatch =
    args.oldString != null ||
    args.old_string != null ||
    args.newString != null ||
    args.new_string != null;
  if (hasPatch) {
    const oldText = String(args.oldString ?? args.old_string ?? "");
    const newText = String(args.newString ?? args.new_string ?? "");
    const oldLines = oldText ? oldText.split(/\r?\n/).length : 0;
    const newLines = newText ? newText.split(/\r?\n/).length : 0;
    return Math.max(oldLines, newLines);
  }
  const content = String(args.content ?? args.contents ?? "");
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

function normalizeRelative(worktree, filePath) {
  const absolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(worktree, filePath);
  const relative = path.relative(path.resolve(worktree), absolute).replace(/\\/g, "/");
  return { absolute, relative };
}

function comparePath(file) {
  const normalized = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isOrchestratorControlPath(relative) {
  const file = String(relative || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const folded = process.platform === "win32" ? file.toLowerCase() : file;
  const agents = process.platform === "win32" ? "agents.md" : "AGENTS.md";
  return (
    folded === agents ||
    folded.endsWith(`/${agents}`) ||
    folded === ".opencode" ||
    folded.startsWith(".opencode/")
  );
}

export function isImplementerProtectedPath(relative) {
  const file = comparePath(relative);
  const prefixes = IMPLEMENTER_PROTECTED.map((prefix) => comparePath(prefix));
  if (file === ".opencode/handoffs" || file.startsWith(".opencode/handoffs/")) return false;
  return prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
}

function patchPaths(patchText) {
  const paths = [];
  for (const line of String(patchText || "").split(/\r?\n/)) {
    const match = line.match(/^\*\*\*\s+(?:Add|Update|Delete) File:\s*(.+?)\s*$/);
    if (match) paths.push(match[1].trim());
  }
  return paths;
}

function patchLineCount(patchText) {
  let count = 0;
  for (const line of String(patchText || "").split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("***")) continue;
    if (line.startsWith("+") || line.startsWith("-")) count += 1;
  }
  return count;
}

export function collectEditTargets(args = {}) {
  const targets = [];
  const direct = editFilePath(args);
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length > 0) {
    for (const edit of edits) {
      targets.push({
        filePath: edit?.filePath || edit?.file_path || edit?.path || direct,
        args: edit || {},
      });
    }
  }
  const patch = args.patchText || args.patch_text || args.patch || null;
  if (typeof patch === "string" && patch.trim()) {
    const paths = patchPaths(patch);
    const lines = patchLineCount(patch);
    if (paths.length === 0) targets.push({ filePath: null, args: {}, lineCount: lines });
    for (const filePath of paths) targets.push({ filePath, args: {}, lineCount: lines });
  }
  if (targets.length === 0 && (direct || args.content != null || args.contents != null || args.oldString != null || args.newString != null)) {
    targets.push({ filePath: direct, args });
  }
  return targets;
}

export function isInstalledPackageEdit(worktree, filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(worktree || "", filePath);
  const relative = worktree ? path.relative(path.resolve(worktree), absolute) : absolute;
  if (worktree && relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return false;
  return absolute.replace(/\\/g, "/").includes("/@mohammad154/opencode-nexus/");
}

const BASH_DENY = [
  { pattern: /(^|[\s;&|])git\s+init\b/i, reason: "git init is performed by the nexus CLI" },
  { pattern: /(^|[\s;&|])git\s+add\b/i, reason: "git add is performed by the nexus CLI" },
  { pattern: /(^|[\s;&|])git\s+commit\b/i, reason: "git commit is performed by the nexus CLI" },
  { pattern: />>?/, reason: "orchestrator bash cannot redirect output" },
  { pattern: /\bfind\b[\s\S]*\s-delete\b/i, reason: "find -delete is not a read-only probe" },
  { pattern: /\bfind\b[\s\S]*\s-exec(?:dir)?\b/i, reason: "find -exec is not a read-only probe" },
];

const IMPLEMENTER_BASH_DENY = [
  {
    pattern: /\.opencode[\\/]+runs\b/i,
    reason: "implementer bash cannot touch orchestrator-owned run state",
  },
  {
    pattern: /subagent-timeouts/i,
    reason: "implementer bash cannot touch subagent timeout records",
  },
];

export function assessImplementerBash(command) {
  const text = String(command || "");
  for (const rule of IMPLEMENTER_BASH_DENY) {
    if (rule.pattern.test(text)) return { ok: false, action: "deny", reason: rule.reason };
  }
  return { ok: true, action: "allow" };
}

export function assessOrchestratorBash(command) {
  const text = String(command || "");
  if (!text.trim()) return { ok: false, action: "deny", reason: "bash command is missing" };
  for (const rule of BASH_DENY) {
    if (rule.pattern.test(text)) return { ok: false, action: "deny", reason: rule.reason };
  }
  return { ok: true, action: "allow" };
}

/**
 * @returns {{ ok: boolean, action?: "allow"|"deny", reason?: string, relative?: string }}
 */
export function assessOrchestratorEdit({
  worktree,
  filePath,
  args = {},
  runState = null,
  env = process.env,
  lineLimit = DIRECT_EDIT_LINE_LIMIT,
  lineCount = null,
} = {}) {
  if (!filePath || typeof filePath !== "string") {
    return { ok: false, action: "deny", reason: "edit path is missing" };
  }
  if (!worktree) {
    return { ok: false, action: "deny", reason: "edit has no worktree" };
  }
  const located = normalizeRelative(worktree, filePath);
  if (located.relative.startsWith("..") || path.isAbsolute(located.relative)) {
    return { ok: false, action: "deny", reason: "edit escapes the worktree", relative: located.relative };
  }
  const boundary = validateContainedPath(worktree, located.absolute, {
    allowMissing: true,
    rejectSymlinks: false,
  });
  if (!boundary.ok) {
    return {
      ok: false,
      action: "deny",
      reason: `edit violates filesystem boundary (${boundary.reason})`,
      relative: located.relative,
    };
  }
  if (isOrchestratorControlPath(located.relative)) {
    return { ok: true, action: "allow", reason: "control-plane", relative: located.relative };
  }
  const flag = String(env.NEXUS_DIRECT_ORCHESTRATOR_EDIT ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") {
    return { ok: false, action: "deny", reason: "direct orchestrator edits are disabled" };
  }
  if (!isDirectFastPath(runState)) {
    return { ok: false, action: "deny", reason: "production edits require direct mode" };
  }
  const lines = Number.isFinite(lineCount) ? lineCount : editLineCount(args);
  if (lines > lineLimit) {
    return {
      ok: false,
      action: "deny",
      reason: `direct-mode orchestrator edits are limited to ${lineLimit} lines (got ${lines})`,
      relative: located.relative,
    };
  }
  return { ok: true, action: "allow", reason: "direct-edit", relative: located.relative };
}

export function assessImplementerEdit({ worktree, filePath } = {}) {
  if (!filePath || !worktree) return { ok: true, action: "allow", reason: "unchecked" };
  const located = normalizeRelative(worktree, filePath);
  if (located.relative.startsWith("..") || path.isAbsolute(located.relative)) {
    return { ok: false, action: "deny", reason: "edit escapes the worktree" };
  }
  const boundary = validateContainedPath(worktree, located.absolute, {
    allowMissing: true,
    rejectSymlinks: false,
  });
  if (!boundary.ok) {
    return { ok: false, action: "deny", reason: `edit violates filesystem boundary (${boundary.reason})` };
  }
  if (isImplementerProtectedPath(located.relative)) {
    return { ok: false, action: "deny", reason: "implementer cannot edit orchestrator-owned state" };
  }
  return { ok: true, action: "allow", relative: located.relative };
}

export function assessToolEdit({ agent, worktree, input = {}, args = {}, runState = null, env } = {}) {
  const tool = editToolName(input);
  if (tool === "bash" || tool === "shell") {
    const command = args.command || args.cmd || "";
    if (agent === "orchestrator") return assessOrchestratorBash(command);
    if (agent === "implementer") return assessImplementerBash(command);
    return null;
  }
  if (!EDIT_TOOLS.has(tool)) return null;
  const targets = collectEditTargets(args);
  if (targets.length === 0) {
    if (agent === "orchestrator" || agent === "implementer") {
      return { ok: false, action: "deny", reason: "edit path is missing" };
    }
    return null;
  }
  if (agent === "orchestrator") {
    let productionLines = 0;
    let sawProduction = false;
    let countedPatch = false;
    for (const target of targets) {
      if (isInstalledPackageEdit(worktree, target.filePath)) {
        return { ok: false, action: "deny", reason: "edits to the installed Nexus package are denied" };
      }
      const pathDecision = assessOrchestratorEdit({
        worktree,
        filePath: target.filePath,
        args: target.args,
        runState,
        env,
        lineLimit: Number.POSITIVE_INFINITY,
      });
      if (!pathDecision.ok) return pathDecision;
      if (pathDecision.reason === "control-plane") continue;
      sawProduction = true;
      if (Number.isFinite(target.lineCount)) {
        if (!countedPatch) {
          productionLines += target.lineCount;
          countedPatch = true;
        }
      } else {
        productionLines += editLineCount(target.args || {});
      }
    }
    if (sawProduction && productionLines > DIRECT_EDIT_LINE_LIMIT) {
      return {
        ok: false,
        action: "deny",
        reason: `direct-mode orchestrator edits are limited to ${DIRECT_EDIT_LINE_LIMIT} lines (got ${productionLines})`,
      };
    }
    return { ok: true, action: "allow", reason: sawProduction ? "direct-edit" : "control-plane" };
  }
  if (agent === "implementer") {
    for (const target of targets) {
      if (isInstalledPackageEdit(worktree, target.filePath)) {
        return { ok: false, action: "deny", reason: "edits to the installed Nexus package are denied" };
      }
      const decision = assessImplementerEdit({ worktree, filePath: target.filePath });
      if (!decision.ok) return decision;
    }
    return { ok: true, action: "allow" };
  }
  return null;
}
