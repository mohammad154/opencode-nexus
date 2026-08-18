import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getBlastProvider } from "../../scripts/lib/providers.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("a fabricated PRECISE report bound to a foreign HEAD is downgraded to UNKNOWN", (t) => {
  const worktree = tempDir("nexus-blast-foreign-");
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  // Make it a git repo with a known HEAD.
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  execFileSync("git", ["config", "user.email", "b@example.test"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "Blast"], { cwd: worktree });
  fs.writeFileSync(path.join(worktree, "f.js"), "1\n");
  execFileSync("git", ["add", "f.js"], { cwd: worktree });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: worktree });

  const reportPath = path.join(worktree, "reports", "fabricated.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      risk: "LOW",
      graph_provider: "graphify",
      analysis_quality: "PRECISE",
      graph_quality: "PRECISE",
      analysis_complete: true,
      // freshness claims a DIFFERENT commit than current HEAD
      graph_freshness: { valid: true, current_head: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    }),
  );

  const result = getBlastProvider("graphify").analyze({
    worktree,
    reportPath: "reports/fabricated.json",
  });
  assert.equal(result.ok, true);
  assert.equal(result.report.risk, "UNKNOWN");
  assert.equal(result.report.analysis_quality, "UNKNOWN");
});

test("a pre-existing latest.json is not consumed after a failed generation", (t) => {
  const worktree = tempDir("nexus-blast-stale-");
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const outDir = path.join(worktree, ".opencode", "blast");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "latest.json");
  // A stale report left behind by an earlier run.
  fs.writeFileSync(
    outPath,
    JSON.stringify({
      risk: "LOW",
      graph_provider: "graphify",
      analysis_quality: "PRECISE",
      graph_quality: "PRECISE",
      analysis_complete: true,
      graph_freshness: { valid: true },
    }),
  );

  // No git repo and no changed files → nexus-blast.js will run but should not
  // rewrite latest.json for this invocation (it writes latest.json only with
  // --task). If the file is unchanged, the provider must refuse it as stale.
  const result = getBlastProvider("graphify").analyze({
    worktree,
    outPath,
    // no reportPath, no sealed inline report → falls through to the script
  });
  // Either the script regenerated a fresh report OR we refuse the stale one;
  // we must never return the pre-existing LOW/PRECISE report as trusted.
  if (result.ok) {
    assert.notEqual(
      result.report?.analysis_quality,
      "PRECISE",
      "must not surface the stale PRECISE report as-is",
    );
  } else {
    assert.match(result.error, /stale|failed|regenerate/i);
  }
});
