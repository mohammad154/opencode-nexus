import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const blast = path.join(root, "scripts", "nexus-blast.js");
const graph = path.join(root, "scripts", "nexus-graph.js");

function makeGitFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-blast-"));
  const sourceRoot = path.join(fixtureRoot, "src");
  const outputRoot = path.join(fixtureRoot, ".opencode", "knowledge");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, ".gitignore"), ".opencode/\n");
  fs.writeFileSync(path.join(sourceRoot, "target.js"), "export const target = 1;\n");
  fs.writeFileSync(
    path.join(sourceRoot, "consumer.js"),
    'import { target } from "./target.js";\nconsole.log(target);\n',
  );

  execFileSync("git", ["init", "-q"], { cwd: fixtureRoot });
  execFileSync("git", ["config", "user.email", "nexus-tests@example.invalid"], { cwd: fixtureRoot });
  execFileSync("git", ["config", "user.name", "Nexus Tests"], { cwd: fixtureRoot });
  execFileSync("git", ["add", "."], { cwd: fixtureRoot });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: fixtureRoot });

  const fileList = path.join(fixtureRoot, "files.list");
  fs.writeFileSync(
    fileList,
    [path.join(sourceRoot, "target.js"), path.join(sourceRoot, "consumer.js")].join("\n"),
  );
  const graphResult = spawnSync(
    process.execPath,
    [graph, fileList, fixtureRoot, outputRoot],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(graphResult.status, 0, graphResult.stderr || graphResult.stdout);
  return { fixtureRoot, sourceRoot, outputRoot };
}

function runBlast(fixtureRoot, file = "src/target.js") {
  const result = spawnSync(
    process.execPath,
    [blast, "--json", "--files", file],
    { cwd: fixtureRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function cleanup(fixture) {
  fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
}

test("blast default output is JSON with freshness and explicit unsupported fields", () => {
  const result = spawnSync(process.execPath, [blast, "--files", "README.md"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.risk || report.level);
  assert.ok(Array.isArray(report.uncertainties));
  assert.equal(typeof report.graph_freshness, "object");
  assert.equal(typeof report.unsupported_fields, "object");
  assert.equal(report.dimensions.supported, false);
  assert.equal("changed_symbols" in report, false);
  assert.equal("tests" in report, false);
  assert.notEqual(report.risk, "LOW");
  assert.ok(!String(result.stdout).includes("```mermaid"));
});

test("blast --mermaid emits mermaid", () => {
  const result = spawnSync(
    process.execPath,
    [blast, "--files", "README.md", "--mermaid"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.stdout.includes("```mermaid"));
});

test("stale source fingerprint cannot produce a confident LOW result", (t) => {
  const fixture = makeGitFixture();
  t.after(() => cleanup(fixture));
  fs.appendFileSync(path.join(fixture.sourceRoot, "target.js"), "// changed\n");

  const report = runBlast(fixture.fixtureRoot);
  assert.equal(report.risk, "UNKNOWN");
  assert.equal(report.level, "UNKNOWN");
  assert.equal(report.graph_freshness.valid, false);
  assert.match(report.uncertainties.join("\n"), /fingerprint|stale/i);
});

test("fresh conservative graph reports low-confidence risk as UNKNOWN", (t) => {
  const fixture = makeGitFixture();
  t.after(() => cleanup(fixture));
  const graphPath = path.join(fixture.outputRoot, "graph.json");
  const graphReport = JSON.parse(fs.readFileSync(graphPath, "utf8"));
  graphReport.extractor_quality = "CONSERVATIVE";
  graphReport.extractor.quality = "CONSERVATIVE";
  fs.writeFileSync(graphPath, JSON.stringify(graphReport, null, 2));

  const report = runBlast(fixture.fixtureRoot);
  assert.equal(report.risk, "UNKNOWN");
  assert.equal(report.computed_risk, "LOW");
  assert.equal(report.analysis_quality, "CONSERVATIVE");
  assert.match(report.uncertainties.join("\n"), /quality|precision/i);
});
