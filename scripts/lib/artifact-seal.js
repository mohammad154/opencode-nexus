/**
 * Provider artifact sealing — shared by state machine and providers.
 *
 * Digests prove integrity (tamper/audit), NOT authenticity or provenance.
 * A caller who can write JSON can also compute the same SHA-256. Safety-critical
 * transitions must recompute evidence via providers; never treat
 * provider_validated alone as proof that a trusted backend produced the report.
 */
import { createHash } from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function sealProviderArtifact(report, worktreeHead = null, extra = {}) {
  if (!report || typeof report !== "object") return null;
  const sealed = {
    ...report,
    ...extra,
    worktree_head: worktreeHead || report.worktree_head || null,
    provider_validated: true,
    validated_at: nowIso(),
  };
  delete sealed.artifact_digest;
  sealed.artifact_digest = sha256Digest(stableStringify(sealed));
  return sealed;
}

export function verifySealedArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") return false;
  if (artifact.provider_validated !== true) return false;
  if (typeof artifact.artifact_digest !== "string") return false;
  const { artifact_digest, ...canonical } = artifact;
  return artifact_digest === sha256Digest(stableStringify(canonical));
}

export { sha256Digest, stableStringify, nowIso };
