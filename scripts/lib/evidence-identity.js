/**
 * Canonical evidence identity.
 *
 * An expensive measurement may be reused only while every component of its
 * identity is provably unchanged. These helpers are deliberately fail-closed:
 * a missing or unusable component returns `null`, and a `null` identity can
 * never match another identity. Callers must therefore recompute whenever an
 * identity cannot be established.
 *
 * Identities prove *equivalence of inputs*, never authenticity. Sealed-artifact
 * integrity (`verifySealedArtifact`) remains a separate, additional requirement
 * before any recorded result may be reused.
 */
import fs from "node:fs";
import path from "node:path";
import { sha256Digest, stableStringify } from "./artifact-seal.js";

/**
 * Bump when the impact analyzer's output contract or algorithm changes in a way
 * that makes a previously persisted report non-equivalent.
 */
export const IMPACT_ANALYZER_VERSION = "nexus-impact/1";

/** Bump when the verification identity components below change. */
export const VERIFICATION_IDENTITY_VERSION = "nexus-verification-identity/1";

/** Lockfiles and manifests that can change an executable check's result. */
const DEPENDENCY_FILES = Object.freeze([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "poetry.lock",
  "Pipfile.lock",
  "requirements.txt",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizedArgv(command, argv) {
  if (Array.isArray(argv) && argv.length > 0) {
    return argv.every((entry) => typeof entry === "string")
      ? argv.map((entry) => entry)
      : null;
  }
  const single = nonEmptyString(command);
  return single ? [single] : null;
}

/**
 * Structured argv for a discovered verification step. Two steps are the same
 * executable work only when this list is identical.
 */
export function stepArgv(step = {}) {
  const command = nonEmptyString(step.command);
  if (!command) return null;
  const args = Array.isArray(step.args) ? step.args : [];
  if (!args.every((entry) => typeof entry === "string")) return null;
  return [command, ...args];
}

/**
 * Toolchain fingerprint. A different runtime can legitimately produce a
 * different result for the same command, so it is part of the identity.
 */
export function environmentFingerprint(source = process) {
  return sha256Digest(
    stableStringify({
      node: nonEmptyString(source?.version),
      platform: nonEmptyString(source?.platform),
      arch: nonEmptyString(source?.arch),
    }),
  );
}

/**
 * Digest the dependency manifests present in a worktree. Absence is a valid,
 * stable identity ("no dependency inputs"), but an unreadable file is not:
 * that returns `null` so callers recompute instead of reusing.
 */
export function dependencyDigest(worktree, options = {}) {
  const root = nonEmptyString(worktree);
  if (!root) return null;
  const files = Array.isArray(options.files) ? options.files : DEPENDENCY_FILES;
  const entries = [];
  for (const relative of files) {
    const absolute = path.join(root, relative);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return null;
    }
    // A symlinked lockfile is not a measurable identity component here.
    if (!stat.isFile()) return null;
    try {
      entries.push([relative, sha256Digest(fs.readFileSync(absolute))]);
    } catch {
      return null;
    }
  }
  entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return sha256Digest(stableStringify({ dependencies: entries }));
}

/**
 * Identity of one executable verification result.
 *
 * Required: head, workspace digest, argv, configuration digest.
 * Optional but included when supplied: scope-policy digest, dependency digest,
 * environment identity. An omitted optional component is recorded as `null`,
 * so an identity computed with it can never collide with one computed without.
 *
 * @returns {string|null} `sha256:<hex>` identity, or null when fail-closed.
 */
export function verificationIdentity(input = {}) {
  const head = nonEmptyString(input.head);
  const workspaceDigest = nonEmptyString(
    input.workspace_digest ?? input.workspaceDigest,
  );
  const configDigest = nonEmptyString(input.config_digest ?? input.configDigest);
  const argv = normalizedArgv(input.command, input.argv);
  if (!head || !workspaceDigest || !configDigest || !argv) return null;

  return sha256Digest(
    stableStringify({
      version: VERIFICATION_IDENTITY_VERSION,
      head,
      workspace_digest: workspaceDigest,
      argv,
      config_digest: configDigest,
      policy_digest: nonEmptyString(input.policy_digest ?? input.policyDigest),
      dependency_digest: nonEmptyString(
        input.dependency_digest ?? input.dependencyDigest,
      ),
      environment_identity: nonEmptyString(
        input.environment_identity ?? input.environmentIdentity,
      ),
    }),
  );
}

/**
 * Stable digest of a target set. Order and duplicates are not part of the
 * identity; membership is.
 */
export function targetSetDigest(targets) {
  const list = Array.isArray(targets) ? targets : targets == null ? [] : [targets];
  const normalized = [
    ...new Set(
      list
        .map((entry) =>
          typeof entry === "string" ? entry : entry?.path || entry?.file || "",
        )
        .map((entry) => String(entry || "").replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter(Boolean),
    ),
  ].sort();
  return sha256Digest(stableStringify({ targets: normalized }));
}

/**
 * Identity of an impact analysis. Impact reads the working tree, not just the
 * commit, so the workspace digest is required alongside HEAD.
 *
 * @returns {string|null}
 */
export function impactIdentity(input = {}) {
  const head = nonEmptyString(input.head);
  const workspaceDigest = nonEmptyString(
    input.workspace_digest ?? input.workspaceDigest,
  );
  if (!head || !workspaceDigest) return null;

  return sha256Digest(
    stableStringify({
      analyzer_version: nonEmptyString(
        input.analyzer_version ?? input.analyzerVersion,
      ) || IMPACT_ANALYZER_VERSION,
      head,
      workspace_digest: workspaceDigest,
      base: nonEmptyString(input.base),
      phase: nonEmptyString(input.phase),
      change_class: nonEmptyString(input.change_class ?? input.changeClass),
      target_digest: targetSetDigest(input.targets ?? input.planned_targets),
      policy_digest: nonEmptyString(input.policy_digest ?? input.policyDigest),
    }),
  );
}

/**
 * Identity of cached project reconnaissance (Phase 10 groundwork). Digests the
 * declared source files; a missing file contributes `null` rather than being
 * silently skipped, so adding one invalidates the profile.
 */
export function projectProfileIdentity(worktree, files = []) {
  const root = nonEmptyString(worktree);
  if (!root) return null;
  const list = Array.isArray(files) ? [...files].sort() : [];
  if (list.length === 0) return null;
  const sources = {};
  for (const relative of list) {
    const absolute = path.join(root, relative);
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile()) {
        sources[relative] = null;
        continue;
      }
      sources[relative] = sha256Digest(fs.readFileSync(absolute));
    } catch (error) {
      if (error?.code === "ENOENT") {
        sources[relative] = null;
        continue;
      }
      return null;
    }
  }
  return sha256Digest(stableStringify({ sources }));
}

/**
 * Resolve every identity component a verification run needs once, so each step
 * identity in that run is computed from the same measured inputs.
 */
export function verificationIdentityContext({
  head,
  workspaceDigest,
  configDigest,
  policyDigest = null,
  worktree = null,
  dependencyDigest: suppliedDependencyDigest,
  environmentIdentity,
} = {}) {
  const resolvedDependencyDigest =
    suppliedDependencyDigest !== undefined
      ? suppliedDependencyDigest
      : worktree
        ? dependencyDigest(worktree)
        : null;
  return {
    head: nonEmptyString(head),
    workspace_digest: nonEmptyString(workspaceDigest),
    config_digest: nonEmptyString(configDigest),
    policy_digest: nonEmptyString(policyDigest),
    dependency_digest: nonEmptyString(resolvedDependencyDigest),
    environment_identity:
      nonEmptyString(environmentIdentity) || environmentFingerprint(),
  };
}

/**
 * Identity for one step inside a resolved run context.
 *
 * @returns {string|null}
 */
export function stepIdentity(context, step) {
  const argv = stepArgv(step);
  if (!argv) return null;
  return verificationIdentity({ ...context, argv });
}

/**
 * Decide whether a recorded result may substitute for executing `step`.
 *
 * Reuse requires: a resolvable identity, an exact identity match, a recorded
 * pass, and identical argv. A failure, timeout, unavailable, or skipped result
 * is never reusable — optimization must not hide a failing check.
 */
export function isReusableVerificationResult(result, { identity, argv } = {}) {
  if (!result || typeof result !== "object") return false;
  if (!nonEmptyString(identity)) return false;
  if (result.pass !== true) return false;
  if (result.status === "UNAVAILABLE" || result.status === "SKIPPED") return false;
  if (result.timed_out === true) return false;
  if (nonEmptyString(result.identity) !== nonEmptyString(identity)) return false;
  if (Array.isArray(argv)) {
    if (!Array.isArray(result.argv) || result.argv.length !== argv.length) return false;
    if (!result.argv.every((entry, index) => entry === argv[index])) return false;
  }
  return true;
}

export { DEPENDENCY_FILES };
