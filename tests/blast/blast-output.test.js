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

function makeGitFixture({ directed = true, useEdges = false } = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-blast-"));
  const sourceRoot = path.join(fixtureRoot, "src");
  const outputRoot = path.join(fixtureRoot, "graphify-out");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, ".gitignore"), "graphify-out/cache/\n");
  fs.writeFileSync(path.join(sourceRoot, "target.js"), "export const target = 1;\n");
  fs.writeFileSync(
    path.join(sourceRoot, "consumer.js"),
    'import { target } from "./target.js";\nconsole.log(target);\n',
  );
  fs.writeFileSync(
    path.join(sourceRoot, "helper.js"),
    'import "./consumer.js";\n',
  );

  execFileSync("git", ["init", "-q"], { cwd: fixtureRoot });
  execFileSync("git", ["config", "user.email", "nexus-tests@example.invalid"], { cwd: fixtureRoot });
  execFileSync("git", ["config", "user.name", "Nexus Tests"], { cwd: fixtureRoot });
  execFileSync("git", ["add", "."], { cwd: fixtureRoot });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: fixtureRoot });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fixtureRoot,
    encoding: "utf8",
  }).trim();

  const nodes = [
    { id: "target", label: "target.js", source_file: "src/target.js" },
    { id: "consumer", label: "consumer.js", source_file: "src/consumer.js" },
    { id: "helper", label: "helper.js", source_file: "src/helper.js" },
  ];
  const links = [
    { source: "consumer", target: "target", relation: "imports" },
    { source: "helper", target: "consumer", relation: "calls" },
  ];
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, ".graphify_root"), `${fixtureRoot}\n`);
  fs.writeFileSync(
    path.join(outputRoot, "graph.json"),
    JSON.stringify({
      directed,
      multigraph: false,
      graph: {},
      nodes,
      ...(useEdges ? { edges: links } : { links }),
      built_at_commit: head,
    }, null, 2),
  );
  const manifest = {};
  for (const file of ["src/target.js", "src/consumer.js", "src/helper.js"]) {
    manifest[file] = { mtime: fs.statSync(path.join(fixtureRoot, file)).mtimeMs / 1000 };
  }
  fs.writeFileSync(path.join(outputRoot, "manifest.json"), JSON.stringify(manifest));

  const graphify = path.join(fixtureRoot, "graphify");
  fs.writeFileSync(graphify, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(graphify, 0o755);
  return { fixtureRoot, sourceRoot, outputRoot, graphify };
}

function runBlast(fixtureRoot, outputRoot, graphify, file = "src/target.js", extra = []) {
  const result = spawnSync(
    process.execPath,
    [blast, "--json", "--files", file, ...extra],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NEXUS_WORKTREE: fixtureRoot,
        GRAPHIFY_OUT: outputRoot,
        PATH: `${fixtureRoot}:${process.env.PATH || ""}`,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function cleanup(fixture) {
  fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
}

test("blast default output is Graphify-backed JSON with explicit unsupported fields", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-blast-default-"));
  const outputRoot = path.join(fixtureRoot, "graphify-out");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const graphify = path.join(fixtureRoot, "graphify");
  fs.writeFileSync(graphify, "#!/bin/sh\nexit 7\n");
  fs.chmodSync(graphify, 0o755);
  const result = spawnSync(process.execPath, [blast, "--files", "README.md"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NEXUS_WORKTREE: root,
      GRAPHIFY_OUT: outputRoot,
      PATH: `${fixtureRoot}:${process.env.PATH || ""}`,
    },
  });
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.risk, "UNKNOWN");
  assert.equal(report.computed_risk, "UNKNOWN");
  assert.ok(Array.isArray(report.uncertainties));
  assert.equal(typeof report.graph_freshness, "object");
  assert.equal(typeof report.unsupported_fields, "object");
  assert.equal(report.dimensions.supported, false);
  assert.equal("changed_symbols" in report, false);
  assert.equal("tests" in report, false);
  assert.equal(report.graph_provider, "graphify");
  assert.ok(!String(result.stdout).includes("```mermaid"));
});

test("blast --mermaid emits mermaid without treating UNKNOWN as LOW", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-blast-mermaid-"));
  const outputRoot = path.join(fixtureRoot, "graphify-out");
  const graphify = path.join(fixtureRoot, "graphify");
  fs.writeFileSync(graphify, "#!/bin/sh\nexit 7\n");
  fs.chmodSync(graphify, 0o755);
  const result = spawnSync(
    process.execPath,
    [blast, "--files", "README.md", "--mermaid"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NEXUS_WORKTREE: root,
        GRAPHIFY_OUT: outputRoot,
        PATH: `${fixtureRoot}:${process.env.PATH || ""}`,
      },
    },
  );
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.stdout.includes("```mermaid"));
});

test("stale Graphify manifest cannot produce a confident LOW result", (t) => {
  const fixture = makeGitFixture();
  t.after(() => cleanup(fixture));
  fs.appendFileSync(path.join(fixture.sourceRoot, "target.js"), "// changed\n");

  const report = runBlast(
    fixture.fixtureRoot,
    fixture.outputRoot,
    fixture.graphify,
  );
  assert.equal(report.risk, "UNKNOWN");
  assert.equal(report.level, "UNKNOWN");
  assert.equal(report.computed_risk, "UNKNOWN");
  assert.equal(report.graph_freshness.valid, false);
  assert.match(report.uncertainties.join("\n"), /changed after refresh|stale/i);
});

test("fresh directed Graphify links produce reverse impact and trusted LOW risk", (t) => {
  const fixture = makeGitFixture({ useEdges: true });
  t.after(() => cleanup(fixture));

  const report = runBlast(
    fixture.fixtureRoot,
    fixture.outputRoot,
    fixture.graphify,
  );
  assert.equal(report.risk, "LOW");
  assert.equal(report.computed_risk, "LOW");
  assert.equal(report.analysis_quality, "PRECISE");
  assert.equal(report.graph_quality, "PRECISE");
  assert.deepEqual(report.direct_dependents, ["src/consumer.js"]);
  assert.ok(report.impacts.some((impact) => impact.file === "src/helper.js"));
  assert.equal(report.graph_provider, "graphify");
});

test("undirected Graphify graphs remain UNKNOWN even when they have callers", (t) => {
  const fixture = makeGitFixture({ directed: false });
  t.after(() => cleanup(fixture));

  const report = runBlast(
    fixture.fixtureRoot,
    fixture.outputRoot,
    fixture.graphify,
  );
  assert.equal(report.risk, "UNKNOWN");
  assert.equal(report.analysis_quality, "UNKNOWN");
  assert.equal(report.graph_quality, "UNKNOWN");
  assert.match(report.uncertainties.join("\n"), /not directed|UNDIRECTED/i);
});
