/**
 * Fail-closed containment checks for repository-owned filesystem paths.
 *
 * A lexical path check alone is insufficient: an existing component may be a
 * symlink whose canonical target is outside the repository. Callers that are
 * about to create runtime state can also reject every existing symlink
 * component so an apparently safe path cannot be redirected between checks.
 */
import fs from "node:fs";
import path from "node:path";

export const FILESYSTEM_BOUNDARY = "FILESYSTEM_BOUNDARY";

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function isMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function hasNul(value) {
  return typeof value === "string" && value.includes("\0");
}

function firstSymlinkComponent(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return null;
  }

  let current = root;
  for (const part of relative.split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return current;
    } catch (error) {
      // Once an ancestor is missing, no later component can be an existing
      // symlink in this path. Other errors are reported by realpath below.
      if (isMissing(error)) return null;
      return null;
    }
  }
  return null;
}

function nearestExisting(candidate) {
  let current = candidate;
  const missing = [];
  while (true) {
    try {
      fs.lstatSync(current);
      return { path: current, missing };
    } catch (error) {
      if (!isMissing(error)) return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Validate lexical and canonical containment.
 *
 * `allowMissing` permits a leaf (or future runtime directories) that the
 * caller is about to create; its nearest existing ancestor is still resolved.
 * `rejectSymlinks` rejects any existing symlink component, including the
 * candidate itself. Without it, canonical containment still rejects symlink
 * targets that resolve outside `root`.
 */
export function validateContainedPath(
  root,
  candidate,
  { allowMissing = true, rejectSymlinks = false, rejectSymlinkComponents = false } = {},
) {
  if (
    typeof root !== "string" ||
    typeof candidate !== "string" ||
    !root ||
    !candidate ||
    hasNul(root) ||
    hasNul(candidate)
  ) {
    return { ok: false, reason: "invalid_path", path: String(candidate || "") };
  }

  let lexicalRoot;
  let lexicalCandidate;
  try {
    lexicalRoot = path.resolve(root);
    lexicalCandidate = path.resolve(candidate);
  } catch {
    return { ok: false, reason: "invalid_path", path: String(candidate || "") };
  }

  if (!isWithin(lexicalRoot, lexicalCandidate)) {
    return {
      ok: false,
      reason: "outside_root",
      path: lexicalCandidate,
    };
  }

  let canonicalRoot;
  try {
    if (!fs.statSync(lexicalRoot).isDirectory()) {
      return { ok: false, reason: "invalid_root", path: lexicalCandidate };
    }
    canonicalRoot = fs.realpathSync(lexicalRoot);
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === "ENOTDIR" ? "invalid_root" : "unreadable_root",
      path: lexicalCandidate,
    };
  }

  const rejectExistingSymlinks = rejectSymlinks || rejectSymlinkComponents;
  if (rejectExistingSymlinks) {
    let rootIsSymlink = false;
    try {
      rootIsSymlink = fs.lstatSync(lexicalRoot).isSymbolicLink();
    } catch {
      return { ok: false, reason: "unreadable_root", path: lexicalCandidate };
    }
    if (rootIsSymlink) {
      return {
        ok: false,
        reason: "symlink_component",
        path: lexicalCandidate,
        symlink_path: lexicalRoot,
      };
    }
    const symlinkPath = firstSymlinkComponent(lexicalRoot, lexicalCandidate);
    if (symlinkPath) {
      return {
        ok: false,
        reason: "symlink_component",
        path: lexicalCandidate,
        symlink_path: symlinkPath,
      };
    }
  }

  let canonicalCandidate;
  let exists = true;
  try {
    canonicalCandidate = fs.realpathSync(lexicalCandidate);
  } catch (error) {
    if (!isMissing(error)) {
      return { ok: false, reason: "unreadable_path", path: lexicalCandidate };
    }
    if (!allowMissing) {
      return { ok: false, reason: "missing_path", path: lexicalCandidate };
    }

    const existing = nearestExisting(lexicalCandidate);
    if (!existing) {
      return { ok: false, reason: "unreadable_path", path: lexicalCandidate };
    }
    try {
      if (
        existing.missing.length > 0 &&
        !fs.statSync(existing.path).isDirectory()
      ) {
        return { ok: false, reason: "invalid_parent", path: lexicalCandidate };
      }
      canonicalCandidate = path.join(
        fs.realpathSync(existing.path),
        ...existing.missing,
      );
      exists = false;
    } catch {
      return { ok: false, reason: "unreadable_path", path: lexicalCandidate };
    }
  }

  if (!isWithin(canonicalRoot, canonicalCandidate)) {
    return {
      ok: false,
      reason: "outside_root",
      path: lexicalCandidate,
      realpath: canonicalCandidate,
    };
  }

  return {
    ok: true,
    path: lexicalCandidate,
    realpath: canonicalCandidate,
    exists,
  };
}

export function boundaryError(label, result) {
  const error = new Error(
    `${label} violates filesystem boundary (${result?.reason || "invalid_path"})`,
  );
  error.code = FILESYSTEM_BOUNDARY;
  error.reason = result?.reason || "invalid_path";
  if (result?.path) error.path = result.path;
  if (result?.realpath) error.realpath = result.realpath;
  if (result?.symlink_path) error.symlink_path = result.symlink_path;
  return error;
}

export function assertContainedPath(
  root,
  candidate,
  options = {},
  label = "path",
) {
  const result = validateContainedPath(root, candidate, options);
  if (!result.ok) throw boundaryError(label, result);
  return result;
}
