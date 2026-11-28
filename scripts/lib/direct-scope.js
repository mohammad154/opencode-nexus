/**
 * Scope helpers shared by the direct seal and the no-automated-checks path.
 * Pure: no git calls and no imports from the rest of Nexus, so the seal and
 * the verifier decide "in scope" with one definition.
 */
import path from "node:path";

export function normalizeScopePath(file) {
  let value = String(file ?? "").trim().replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  return value;
}

function isContainedRelative(value) {
  if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return !value.split("/").includes("..") && !path.posix.isAbsolute(value);
}

export function normalizeAllowedFiles(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const file of list) {
    if (typeof file !== "string") continue;
    const value = normalizeScopePath(file);
    if (isContainedRelative(value)) out.add(value);
  }
  return [...out];
}

/**
 * Parse `git status --porcelain=v1 -z`. Rename and copy entries carry their
 * source path as the following NUL-separated token; both paths are returned
 * so a moved file cannot escape scope through its old name.
 */
export function parseStatusZ(stdout) {
  const tokens = String(stdout || "").split("\0").filter((token) => token.length > 0);
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const code = token.slice(0, 2);
    const paths = [normalizeScopePath(token.slice(3))];
    if (code.includes("R") || code.includes("C")) {
      index += 1;
      if (tokens[index] !== undefined) paths.push(normalizeScopePath(tokens[index]));
    }
    entries.push({ status: code, paths });
  }
  return entries;
}

export function changedPathsFromEntries(entries) {
  const changed = new Set();
  for (const entry of entries) {
    for (const file of entry.paths) if (file) changed.add(file);
  }
  return [...changed].sort();
}

export function outOfScopePaths(changed, allowed) {
  const allowedSet = new Set(allowed);
  return changed.filter((file) => !allowedSet.has(file)).sort();
}

export const SCOPE_DRIFT_HINT =
  "Undo the change to these paths (restore tracked files, delete new files) so the edit touches only allowed_files, then run nexus run transition --to VERIFYING again. To change the scope, escalate to the standard pipeline.";
