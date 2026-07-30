import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const graphScript = path.join(repoRoot, "scripts", "nexus-graph.js");

function makeFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-graph-"));
  const sourceRoot = path.join(fixtureRoot, "src");
  const outputRoot = path.join(fixtureRoot, ".opencode", "knowledge");
  fs.mkdirSync(sourceRoot, { recursive: true });

  fs.writeFileSync(path.join(sourceRoot, "actual.js"), "export const actual = 1;\n");
  fs.writeFileSync(path.join(sourceRoot, "commented.js"), "export const commented = 1;\n");
  fs.writeFileSync(path.join(sourceRoot, "string.js"), "export const stringValue = 1;\n");
  fs.writeFileSync(path.join(sourceRoot, "regex.js"), "export const regexValue = 1;\n");
  fs.writeFileSync(
    path.join(sourceRoot, "consumer.js"),
    [
      '// import fake from "./commented.js";',
      "/* export { fake } from './commented.js'; */",
      'const example = "import fake from \'./string.js\'";',
      "const pattern = /import fake from 'regex.js'/;",
      'const objectExample = { import: { from: "./object.js" } };',
      'import actual from "./actual.js";',
      'export { actual } from "./actual.js";',
      'const loaded = require("./actual.js");',
      'const dynamic = import("./actual.js");',
      "console.log(actual, loaded, dynamic, example, pattern);",
      "",
    ].join("\n"),
  );

  const fileList = path.join(fixtureRoot, "files.list");
  fs.writeFileSync(
    fileList,
    [
      path.join(sourceRoot, "consumer.js"),
      path.join(sourceRoot, "actual.js"),
      path.join(sourceRoot, "commented.js"),
      path.join(sourceRoot, "string.js"),
      path.join(sourceRoot, "regex.js"),
    ].join("\n"),
  );

  return { fixtureRoot, sourceRoot, outputRoot, fileList };
}

function runGraph(fixture) {
  const result = spawnSync(
    process.execPath,
    [graphScript, fixture.fileList, fixture.fixtureRoot, fixture.outputRoot],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(fs.readFileSync(path.join(fixture.outputRoot, "graph.json"), "utf8"));
}

function cleanup(fixture) {
  fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
}

test("JS/TS extraction ignores comments, strings, and regex examples", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const graph = runGraph(fixture);
  const consumerEdges = graph.edges.filter((edge) => edge.from === "src/consumer.js");
  const targets = consumerEdges.map((edge) => edge.to);

  assert.ok(targets.includes("src/actual.js"), JSON.stringify(consumerEdges));
  assert.ok(!targets.includes("src/commented.js"), JSON.stringify(consumerEdges));
  assert.ok(!targets.includes("src/string.js"), JSON.stringify(consumerEdges));
  assert.ok(!targets.includes("regex.js"), JSON.stringify(consumerEdges));
  assert.ok(!targets.includes("src/object.js"), JSON.stringify(consumerEdges));
  assert.ok(graph.extractor_quality);
  assert.ok(graph.extractor?.quality);
  assert.match(graph.nodes.find((node) => node.id === "src/consumer.js").file_hash, /^sha256:/);
  assert.match(graph.source_fingerprint, /^sha256:/);
  assert.match(graph.working_tree_fingerprint, /^sha256:/);
});

test("graph cache reuses unchanged file analysis by content hash", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  runGraph(fixture);
  const second = runGraph(fixture);
  assert.equal(second.cache.reused_nodes, 5);
  assert.equal(second.cache.rebuilt_nodes, 0);
  assert.ok(second.cache.reused_edges >= 1);

  fs.appendFileSync(path.join(fixture.sourceRoot, "consumer.js"), "// changed\n");
  const third = runGraph(fixture);
  assert.equal(third.cache.reused_nodes, 4);
  assert.equal(third.cache.rebuilt_nodes, 1);
  assert.ok(third.nodes.every((node) => node.file_hash));
});
