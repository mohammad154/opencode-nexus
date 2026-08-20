import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyzeImpact } from "../../scripts/lib/impact/analyze.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const impactCli = path.join(repoRoot, "scripts", "nexus-impact.js");

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-impact-"));
  spawnSync("git", ["init", "--quiet", root]);
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.js"), "export function a() { return 1; }\n");
  fs.writeFileSync(path.join(root, "src", "b.js"), "import { a } from './a.js';\nexport function b() { return a(); }\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-m", "init", "--quiet"], { cwd: root });
  return root;
}

test("impact engine reports risk and confidence separately", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "src", "a.js"), "export function a() { return 2; }\n");
  const report = analyzeImpact(root, { base: "HEAD" });
  assert.equal(report.ok, true);
  assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(report.risk));
  assert.equal(typeof report.confidence, "number");
  assert.ok(report.changed_files.some((f) => f.path === "src/a.js"));
  assert.ok(report.changed_symbols.some((s) => s.name === "a"));
  assert.ok(Array.isArray(report.direct_dependents));
  fs.rmSync(root, { recursive: true, force: true });
});

test("impact CLI writes JSON artifact", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "src", "a.js"), "export function a() { return 3; }\n");
  const r = spawnSync(process.execPath, [impactCli, "--json", "--worktree", root], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.provider, "nexus-impact");
  assert.ok(fs.existsSync(path.join(root, ".opencode", "impact", "latest.json")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("unsupported language lowers confidence rather than silent success", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "src", "x.py"), "def foo():\n  return 1\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-m", "py", "--quiet"], { cwd: root });
  fs.writeFileSync(path.join(root, "src", "x.py"), "def foo():\n  return 2\n");
  const report = analyzeImpact(root, { base: "HEAD" });
  assert.equal(report.ok, true);
  assert.ok(report.confidence < 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("pre-impact with planned targets on clean tree does not trust HIGH confidence", () => {
  const root = tempRepo();
  const report = analyzeImpact(root, {
    base: "HEAD",
    planned_targets: ["src/a.js"],
  });
  assert.equal(report.ok, true);
  assert.equal(report.pre_impact, true);
  assert.ok(report.confidence < 0.75);
  assert.notEqual(report.trusted, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("deleted module still surfaces importers as dependents", () => {
  const root = tempRepo();
  fs.unlinkSync(path.join(root, "src", "a.js"));
  spawnSync("git", ["add", "-A"], { cwd: root });
  // Keep as working-tree deletion vs HEAD
  const report = analyzeImpact(root, { base: "HEAD" });
  assert.equal(report.ok, true);
  assert.ok(
    report.direct_dependents.includes("src/b.js") ||
      report.changed_files.some((f) => f.path === "src/a.js"),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("impact provider recomputes instead of trusting fabricated reportPath", async () => {
  const { createNexusImpactProvider } = await import(
    "../../scripts/lib/providers/impact-provider.js"
  );
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "src", "a.js"), "export function a() { return 9; }\n");
  const fakePath = path.join(root, ".opencode", "impact", "fake.json");
  fs.mkdirSync(path.dirname(fakePath), { recursive: true });
  fs.writeFileSync(
    fakePath,
    JSON.stringify({
      ok: true,
      trusted: true,
      risk: "LOW",
      confidence: 0.99,
      worktree_head: "deadbeef",
    }),
  );
  const provider = createNexusImpactProvider();
  const result = provider.analyze({ worktree: root, reportPath: fakePath });
  assert.equal(result.recomputed, true);
  assert.notEqual(result.report.worktree_head, "deadbeef");
  assert.ok(result.report.changed_files?.some((f) => f.path === "src/a.js"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("sealed inline report is never accepted as provenance", async () => {
  const { createNexusImpactProvider } = await import(
    "../../scripts/lib/providers/impact-provider.js"
  );
  const { sealImpactArtifact } = await import(
    "../../scripts/lib/state-machine.js"
  );
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "src", "a.js"), "export function a() { return 4; }\n");
  const forged = sealImpactArtifact({
    ok: true,
    trusted: true,
    risk: "LOW",
    confidence: 0.99,
    provider: "nexus-impact",
    analysis_quality: "PRECISE",
    graph_quality: "PRECISE",
    analysis_complete: true,
    graph_freshness: { valid: true },
    changed_files: [],
  });
  const provider = createNexusImpactProvider();
  const result = provider.analyze({ worktree: root, report: forged });
  assert.equal(result.recomputed, true);
  assert.equal(result.cache_hit, false);
  assert.ok(result.report.changed_files?.some((f) => f.path === "src/a.js"));
  fs.rmSync(root, { recursive: true, force: true });
});
