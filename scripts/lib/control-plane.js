/**
 * Defense-in-depth integrity snapshot for Nexus-owned runtime state.
 *
 * The implementer permission boundary is useful UX, but it is not evidence.
 * This snapshot is written outside the worktree by the controller before an
 * implementer dispatch and checked before VERIFYING.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateContainedPath } from "./filesystem-boundary.js";
import { stableStringify, sha256Digest } from "./artifact-seal.js";

export const CONTROL_PLANE_SNAPSHOT_VERSION = "1.0";

const PROTECTED_DIRECTORIES = Object.freeze([
  ".opencode/runs",
  ".opencode/config",
  ".opencode/impact",
  ".opencode/reviews",
  ".opencode/reconcile",
  ".opencode/cache",
  ".opencode/plans",
  ".opencode/tasks",
]);

const PROTECTED_FILES = Object.freeze([
  ".opencode/active-run",
  ".opencode/CONTEXT.md",
  ".opencode/nexus.json",
]);

function normalizedRoot(worktree) {
  return path.resolve(String(worktree || process.cwd()));
}

function worktreeIdentity(worktree) {
  const root = normalizedRoot(worktree);
  try {
    return fs.realpathSync(root).replace(/\\/g, "/");
  } catch {
    return root.replace(/\\/g, "/");
  }
}

function snapshotFile(worktree, runId) {
  const identity = `${worktreeIdentity(worktree)}\0${String(runId || "")}`;
  const key = createHash("sha256").update(identity).digest("hex");
  return path.join(os.tmpdir(), "opencode-nexus-control-plane", `${key}.json`);
}

function hashFile(file) {
  return sha256Digest(fs.readFileSync(file));
}

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function relative(root, file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

function isSymlinkReason(reason) {
  return String(reason || "").toLowerCase().includes("symlink");
}

function inspectEntry(root, file, records) {
  const rel = relative(root, file);
  const boundary = validateContainedPath(root, file, {
    allowMissing: false,
    rejectSymlinks: true,
  });
  if (!boundary.ok) {
    return {
      ok: false,
      code: isSymlinkReason(boundary.reason) ? "CONTROL_PLANE_SYMLINK" : "CONTROL_PLANE_INVALID_PATH",
      error: `protected path ${rel} failed boundary check: ${boundary.reason}`,
    };
  }
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    return { ok: false, code: "CONTROL_PLANE_UNREADABLE", error: String(error.message || error) };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, code: "CONTROL_PLANE_SYMLINK", error: `protected path is a symlink: ${rel}` };
  }
  if (stat.isDirectory()) {
    records.push({ path: rel, kind: "directory", mode: stat.mode & 0o777 });
    return { ok: true };
  }
  if (!stat.isFile()) {
    return { ok: false, code: "CONTROL_PLANE_SPECIAL_FILE", error: `protected path is not a regular file: ${rel}` };
  }
  try {
    records.push({
      path: rel,
      kind: "file",
      mode: stat.mode & 0o777,
      size: stat.size,
      digest: hashFile(file),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, code: "CONTROL_PLANE_UNREADABLE", error: String(error.message || error) };
  }
}

function walkProtectedDirectory(root, directory, records) {
  const boundary = validateContainedPath(root, directory, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  if (!boundary.ok) {
    return {
      ok: false,
      code: isSymlinkReason(boundary.reason) ? "CONTROL_PLANE_SYMLINK" : "CONTROL_PLANE_INVALID_PATH",
      error: `protected directory failed boundary check: ${relative(root, directory)} (${boundary.reason})`,
    };
  }
  const directoryStat = lstatIfPresent(directory);
  if (!directoryStat) {
    records.push({ path: relative(root, directory), kind: "missing" });
    return { ok: true };
  }
  const rootResult = inspectEntry(root, directory, records);
  if (!rootResult.ok) return rootResult;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    return { ok: false, code: "CONTROL_PLANE_UNREADABLE", error: String(error.message || error) };
  }
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const result = walkProtectedDirectory(root, child, records);
      if (!result.ok) return result;
    } else {
      const result = inspectEntry(root, child, records);
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}

function collectProtectedRecords(worktree) {
  const root = normalizedRoot(worktree);
  const records = [];
  for (const relativeDirectory of PROTECTED_DIRECTORIES) {
    const result = walkProtectedDirectory(root, path.join(root, relativeDirectory), records);
    if (!result.ok) return result;
  }
  for (const relativeFile of PROTECTED_FILES) {
    const file = path.join(root, relativeFile);
    const fileStat = lstatIfPresent(file);
    if (!fileStat) {
      records.push({ path: relativeFile, kind: "missing" });
      continue;
    }
    const result = inspectEntry(root, file, records);
    if (!result.ok) return result;
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, records };
}

function payloadDigest(payload) {
  return sha256Digest(stableStringify(payload));
}

export function captureControlPlaneSnapshot(worktree, { runId } = {}) {
  if (!runId) return { ok: false, code: "CONTROL_PLANE_RUN_ID_MISSING", error: "run id is required" };
  const collected = collectProtectedRecords(worktree);
  if (!collected.ok) return collected;
  const payload = {
    schema_version: CONTROL_PLANE_SNAPSHOT_VERSION,
    run_id: String(runId),
    worktree_identity: worktreeIdentity(worktree),
    protected: collected.records,
  };
  const snapshot = { ...payload, snapshot_digest: payloadDigest(payload) };
  const file = snapshotFile(worktree, runId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(file), 0o700);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    return { ok: false, code: "CONTROL_PLANE_SNAPSHOT_WRITE_FAILED", error: String(error.message || error) };
  }
  return {
    ok: true,
    path: file,
    digest: snapshot.snapshot_digest,
    protected_count: collected.records.length,
  };
}

export function verifyControlPlaneSnapshot(worktree, { runId } = {}) {
  if (!runId) return { ok: false, code: "CONTROL_PLANE_TAMPERED", error: "run id is missing" };
  const file = snapshotFile(worktree, runId);
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return {
      ok: false,
      code: "CONTROL_PLANE_TAMPERED",
      error: `control-plane snapshot unavailable: ${String(error.message || error)}`,
    };
  }
  const { snapshot_digest: supplied, ...payload } = snapshot || {};
  if (
    !snapshot ||
    supplied !== payloadDigest(payload) ||
    snapshot.schema_version !== CONTROL_PLANE_SNAPSHOT_VERSION ||
    String(snapshot.run_id) !== String(runId) ||
    snapshot.worktree_identity !== worktreeIdentity(worktree)
  ) {
    return { ok: false, code: "CONTROL_PLANE_TAMPERED", error: "control-plane snapshot identity or digest mismatch" };
  }
  const collected = collectProtectedRecords(worktree);
  if (!collected.ok) {
    return { ok: false, code: "CONTROL_PLANE_TAMPERED", error: collected.error || collected.code };
  }
  if (stableStringify(collected.records) !== stableStringify(snapshot.protected)) {
    return {
      ok: false,
      code: "CONTROL_PLANE_TAMPERED",
      error: "protected Nexus runtime state changed after implementer dispatch",
      expected_digest: payloadDigest({ protected: snapshot.protected }),
      actual_digest: payloadDigest({ protected: collected.records }),
    };
  }
  return { ok: true, digest: supplied, protected_count: collected.records.length };
}

export { PROTECTED_DIRECTORIES, PROTECTED_FILES };
