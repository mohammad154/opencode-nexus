import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { validateDriftReport } from "./schema-validate.js";

function fileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Semantic drift detection.
 * Commit distance is secondary; broken anchors / signatures drive HIGH.
 *
 * @param {object} input
 * @param {string} [input.worktree]
 * @param {string} [input.plan_commit]
 * @param {string} [input.current_head]
 * @param {number} [input.commit_distance]
 * @param {Array<{file:string,line?:number,symbol?:string,text?:string}>} [input.anchors]
 * @param {Array<{file:string,expected_hash?:string,signature?:string}>} [input.targets]
 * @param {string} [input.graph_version]
 * @param {string} [input.graph_generated_at_commit]
 * @param {boolean} [input.merge_base_changed]
 * @param {string} [input.acceptance_criteria_version]
 * @param {string} [input.expected_acceptance_criteria_version]
 */
export function assessDrift(input = {}) {
  const reasons = [];
  const anchors_broken = [];
  const worktree = input.worktree || process.cwd();
  const commit_distance = Number(input.commit_distance ?? 0);
  let drift = "NONE";

  for (const anchor of input.anchors || []) {
    const full = path.isAbsolute(anchor.file)
      ? anchor.file
      : path.join(worktree, anchor.file);
    if (!fs.existsSync(full)) {
      anchors_broken.push(`${anchor.file}: missing`);
      reasons.push(`Acceptance anchor missing: ${anchor.file}`);
      continue;
    }
    if (anchor.line != null) {
      const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
      const idx = Number(anchor.line) - 1;
      if (idx < 0 || idx >= lines.length) {
        anchors_broken.push(`${anchor.file}:${anchor.line}`);
        reasons.push(
          `Acceptance criteria line anchor no longer resolves: ${anchor.file}:${anchor.line}`,
        );
        continue;
      }
      if (anchor.text && !lines[idx].includes(anchor.text)) {
        anchors_broken.push(`${anchor.file}:${anchor.line}`);
        reasons.push(
          `Line anchor text mismatch at ${anchor.file}:${anchor.line}`,
        );
      }
    }
    if (anchor.symbol) {
      const body = fs.readFileSync(full, "utf8");
      if (!body.includes(anchor.symbol)) {
        anchors_broken.push(`${anchor.file}#${anchor.symbol}`);
        reasons.push(
          `Symbol no longer found: ${anchor.symbol} in ${anchor.file}`,
        );
      }
    }
  }

  for (const t of input.targets || []) {
    const full = path.isAbsolute(t.file) ? t.file : path.join(worktree, t.file);
    if (t.expected_hash) {
      const h = fileHash(full);
      if (h && h !== t.expected_hash) {
        reasons.push(`Target file content hash changed: ${t.file}`);
      } else if (!h) {
        reasons.push(`Target file missing: ${t.file}`);
        anchors_broken.push(t.file);
      }
    }
    if (t.signature) {
      if (
        !fs.existsSync(full) ||
        !fs.readFileSync(full, "utf8").includes(t.signature)
      ) {
        reasons.push(
          `Target symbol signature changed or missing: ${t.signature}`,
        );
        anchors_broken.push(`${t.file}#sig`);
      }
    }
  }

  if (
    input.expected_acceptance_criteria_version &&
    input.acceptance_criteria_version &&
    input.expected_acceptance_criteria_version !==
      input.acceptance_criteria_version
  ) {
    reasons.push("Acceptance criteria version changed");
  }

  if (
    input.graph_generated_at_commit &&
    input.plan_commit &&
    input.graph_version_stale
  ) {
    reasons.push("Dependency graph version stale relative to plan");
  }

  const merge_base_changed = Boolean(input.merge_base_changed);
  if (merge_base_changed) {
    reasons.push("Base branch merge-base moved incompatibly");
  }

  const anchorsFailed = anchors_broken.length > 0;
  const acceptanceVersionMismatch = reasons.some((r) =>
    /Acceptance criteria version changed/i.test(r),
  );
  const semanticHigh =
    anchorsFailed ||
    merge_base_changed ||
    acceptanceVersionMismatch ||
    reasons.some((r) => /signature changed/i.test(r));

  if (semanticHigh) {
    drift = "HIGH";
  } else if (commit_distance > 50) {
    drift = "MEDIUM";
    reasons.push(`Commit distance ${commit_distance} > 50 (secondary signal)`);
  } else if (commit_distance >= 10) {
    drift = "LOW";
    reasons.push(`Commit distance ${commit_distance} (10–50)`);
  } else if (reasons.length === 0) {
    drift = "NONE";
  } else {
    drift = "LOW";
  }

  const report = {
    schema_version: "1.0",
    drift,
    reasons,
    commit_distance,
    plan_commit: input.plan_commit ?? null,
    current_head: input.current_head ?? null,
    anchors_broken,
    merge_base_changed,
  };

  const v = validateDriftReport(report);
  if (!v.ok) {
    report._validation_errors = v.errors;
  }
  return report;
}

export function isPlanCommitAcceptable(driftReport) {
  if (!driftReport || typeof driftReport !== "object") return false;
  if (!driftReport.drift) return false;
  return driftReport.drift !== "HIGH";
}

export { fileHash };
