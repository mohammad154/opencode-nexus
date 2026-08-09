import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseGraphifyGraph,
  mapFilesToGraphifyNodes,
  prepareGraphifyGraph,
  readGraphifyGraph,
  refreshGraphifyGraph,
  resolveGraphifyGraphPath,
  reverseTraverseGraphify,
} from "../../scripts/lib/graphify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function digest(value) {
  return `sha256:${Buffer.from(value).toString("hex")}`;
}

function makeFixture() {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-graphify-"));
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src", "target.js"), "export const target = 1;\n");
  fs.writeFileSync(path.join(worktree, "src", "consumer.js"), "import { target } from './target.js';\n");
  fs.writeFileSync(path.join(worktree, "src", "helper.js"), "import './consumer.js';\n");
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  execFileSync("git", ["config", "user.email", "graphify@example.test"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "Graphify Tests"], { cwd: worktree });
  execFileSync("git", ["add", "src"], { cwd: worktree });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: worktree });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  const out = path.join(worktree, "graphify-out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, ".graphify_root"), `${worktree}\n`);
  const graph = {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: [
      { id: "target", label: "target.js", source_file: "src/target.js", source_location: "L1" },
      { id: "consumer", label: "consumer.js", source_file: "src/consumer.js", source_location: "L1" },
      { id: "helper", label: "helper.js", source_file: "src/helper.js", source_location: "L1" },
    ],
    links: [
      { source: "consumer", target: "target", relation: "imports", confidence: "EXTRACTED" },
      { source: "helper", target: "consumer", relation: "calls", confidence: "EXTRACTED" },
      { source: "target", target: "helper", relation: "mentions", confidence: "EXTRACTED" },
    ],
    built_at_commit: head,
  };
  fs.writeFileSync(path.join(out, "graph.json"), JSON.stringify(graph, null, 2));
  const manifest = {};
  for (const file of ["src/target.js", "src/consumer.js", "src/helper.js"]) {
    manifest[file] = { mtime: fs.statSync(path.join(worktree, file)).mtimeMs / 1000 };
  }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest));
  return { worktree, out, graphPath: path.join(out, "graph.json"), graph };
}

function cleanup(fixture) {
  fs.rmSync(fixture.worktree, { recursive: true, force: true });
}

function fakeGraphify(fixture, body = "exit 0") {
  const command = path.join(fixture.worktree, "fake-graphify");
  fs.writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GRAPHIFY_TEST_LOG"\n${body}\n`);
  fs.chmodSync(command, 0o755);
  return command;
}

test("Graphify output path honors GRAPHIFY_OUT and defaults to graphify-out", () => {
  const old = process.env.GRAPHIFY_OUT;
  delete process.env.GRAPHIFY_OUT;
  assert.match(resolveGraphifyGraphPath("/tmp/project"), /\/tmp\/project\/graphify-out\/graph\.json$/);
  process.env.GRAPHIFY_OUT = "shared-graph";
  assert.match(resolveGraphifyGraphPath("/tmp/project"), /\/tmp\/project\/shared-graph\/graph\.json$/);
  if (old === undefined) delete process.env.GRAPHIFY_OUT;
  else process.env.GRAPHIFY_OUT = old;
});

test("Graphify adapter accepts links and raw edges and reverse-traverses supported relations", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const loaded = readGraphifyGraph({
    worktree: fixture.worktree,
    graphPath: fixture.graphPath,
    outDirectory: fixture.out,
  });
  assert.equal(loaded.ok, true, JSON.stringify(loaded.issues));
  const mapping = mapFilesToGraphifyNodes(
    loaded,
    ["src/target.js", "src/missing.js"],
    fixture.worktree,
  );
  assert.deepEqual(mapping.mapped, [{ file: "src/target.js", node_ids: ["target"] }]);
  assert.deepEqual(mapping.unmapped, ["src/missing.js"]);
  const traversal = reverseTraverseGraphify(loaded, ["src/target.js"], {
    worktree: fixture.worktree,
    depth: 2,
  });
  assert.deepEqual(traversal.mapping.unmapped, []);
  assert.deepEqual(traversal.impacts.map((item) => item.file), ["src/consumer.js", "src/helper.js"]);
  assert.equal(traversal.edges[0].relation, "imports");

  const raw = { ...fixture.graph, links: undefined, edges: fixture.graph.links };
  const parsed = parseGraphifyGraph(raw, { worktree: fixture.worktree, outDirectory: fixture.out });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues));
  assert.equal(parsed.link_key, "edges");
  const relationGraph = {
    ...fixture.graph,
    links: ["imports", "calls", "references", "inherits", "uses"].map((relation) => ({
      source: "consumer",
      target: "target",
      relation,
    })),
  };
  const relationParsed = parseGraphifyGraph(relationGraph, {
    worktree: fixture.worktree,
    outDirectory: fixture.out,
  });
  assert.deepEqual(
    relationParsed.reverse.get("target").map((edge) => edge.relation),
    ["imports", "calls", "references", "inherits", "uses"],
  );
});

test("missing, malformed, stale, and undirected Graphify evidence is never trusted", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  fs.writeFileSync(fixture.graphPath, "{");
  let loaded = readGraphifyGraph({ worktree: fixture.worktree, graphPath: fixture.graphPath, outDirectory: fixture.out });
  assert.equal(loaded.status, "MALFORMED");
  assert.equal(loaded.ok, false);

  fs.writeFileSync(fixture.graphPath, JSON.stringify({ ...fixture.graph, directed: false }));
  loaded = readGraphifyGraph({ worktree: fixture.worktree, graphPath: fixture.graphPath, outDirectory: fixture.out });
  assert.equal(loaded.status, "UNDIRECTED");
  assert.equal(loaded.ok, false);

  fs.writeFileSync(fixture.graphPath, JSON.stringify({ ...fixture.graph, built_at_commit: "old-commit" }));
  loaded = readGraphifyGraph({ worktree: fixture.worktree, graphPath: fixture.graphPath, outDirectory: fixture.out });
  assert.equal(loaded.status, "STALE");
  assert.equal(loaded.freshness.valid, false);

  fs.rmSync(fixture.graphPath);
  loaded = readGraphifyGraph({ worktree: fixture.worktree, graphPath: fixture.graphPath, outDirectory: fixture.out });
  assert.equal(loaded.status, "MISSING");
  assert.equal(loaded.freshness.valid, false);
});

test("Graphify refresh uses extract for missing graphs and update for existing graphs", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const log = path.join(fixture.worktree, "graphify.log");
  const command = fakeGraphify(fixture);
  const env = { ...process.env, GRAPHIFY_TEST_LOG: log };

  const existing = refreshGraphifyGraph({
    worktree: fixture.worktree,
    graphPath: fixture.graphPath,
    command,
    env,
  });
  assert.equal(existing.ok, true);
  assert.deepEqual(existing.command.slice(1), ["update", "."]);

  fs.rmSync(fixture.graphPath);
  const missing = refreshGraphifyGraph({
    worktree: fixture.worktree,
    graphPath: fixture.graphPath,
    command,
    env,
  });
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.command.slice(1), ["extract", ".", "--code-only", "--directed", "--no-viz"]);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual(calls, ["update .", "extract . --code-only --directed --no-viz"]);
});

test("failed Graphify refresh is surfaced as refresh failure", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const command = fakeGraphify(fixture, "exit 7");
  const result = prepareGraphifyGraph({
    worktree: fixture.worktree,
    graphPath: fixture.graphPath,
    command,
    env: { ...process.env, GRAPHIFY_TEST_LOG: path.join(fixture.worktree, "graphify.log") },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "REFRESH_FAILED");
  assert.equal(result.freshness.valid, false);
});

test("missing Graphify executable returns an actionable prerequisite error", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const result = refreshGraphifyGraph({
    worktree: fixture.worktree,
    graphPath: fixture.graphPath,
    command: path.join(fixture.worktree, "does-not-exist"),
    env: process.env,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "GRAPHIFY_UNAVAILABLE");
  assert.match(result.error, /Graphify.*required/i);
});
