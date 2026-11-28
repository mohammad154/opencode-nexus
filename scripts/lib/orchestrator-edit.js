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

export function isOrchestratorControlPath(relative) {
  const file = String(relative || "").replace(/\\/g, "/").replace(/^\.\//, "");
  return file === "AGENTS.md" || file.endsWith("/AGENTS.md") || file === ".opencode" || file.startsWith(".opencode/");
}

export function isImplementerProtectedPath(relative) {
  const file = String(relative || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (file === ".opencode/handoffs" || file.startsWith(".opencode/handoffs/")) return false;
  return IMPLEMENTER_PROTECTED.some(
    (prefix) => file === prefix || file.startsWith(`${prefix}/`),
  );
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
  const lines = editLineCount(args);
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
  if (!EDIT_TOOLS.has(editToolName(input))) return null;
  const filePath = editFilePath(args);
  if (agent === "orchestrator") {
    return assessOrchestratorEdit({ worktree, filePath, args, runState, env });
  }
  if (agent === "implementer") {
    return assessImplementerEdit({ worktree, filePath });
  }
  return null;
}
