import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  readGraphifyGraph,
  isCanonicalGraphifyGraphPath,
  resolveGraphifyGraphPath,
} from "../../scripts/lib/graphify.js";
import { getGraphProvider } from "../../scripts/lib/providers.js";

function makeRepo() {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-provenance-"));
  fs.writeFileSync(path.join(worktree, "index.js"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  execFileSync("git", ["config", "user.email", "p@example.test"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "Provenance"], { cwd: worktree });
  execFileSync("git", ["add", "index.js"], { cwd: worktree });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: worktree });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  }).trim();
  return { worktree, head };
}

function writeCanonicalGraph(worktree, head, { root = true, manifest = true } = {}) {
  const out = path.join(worktree, "graphify-out");
  fs.mkdirSync(out, { recursive: true });
  if (root) fs.writeFileSync(path.join(out, ".graphify_root"), `${worktree}\n`);
  fs.writeFileSync(
    path.join(out, "graph.json"),
    JSON.stringify({
      directed: true,
      built_at_commit: head,
      nodes: [{ id: "index", source_file: "index.js" }],
      links: [],
    }),
  );
  if (manifest) {
    fs.writeFileSync(
      path.join(out, "manifest.json"),
      JSON.stringify({
        "index.js": {
          mtime: fs.statSync(path.join(worktree, "index.js")).mtimeMs / 1000,
        },
      }),
    );
  }
  return path.join(out, "graph.json");
}

test("a custom graph.json path is never canonical", (t) => {
  const { worktree, head } = makeRepo();
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const custom = path.join(worktree, "attacker", "graph.json");
  fs.mkdirSync(path.dirname(custom), { recursive: true });
  fs.writeFileSync(
    custom,
    JSON.stringify({
      directed: true,
      built_at_commit: head, // matches HEAD, but wrong location
      nodes: [{ id: "index", source_file: "index.js" }],
      links: [],
    }),
  );
  assert.equal(isCanonicalGraphifyGraphPath(custom, worktree), false);
  assert.equal(
    isCanonicalGraphifyGraphPath(resolveGraphifyGraphPath(worktree), worktree),
    true,
  );

  const loaded = readGraphifyGraph({
    worktree,
    graphPath: custom,
    outDirectory: path.dirname(custom),
  });
  assert.equal(loaded.canonical, false);
  assert.equal(loaded.status, "NON_CANONICAL");
  assert.equal(loaded.freshness.valid, false);
});

test("a foreign graph.json at the canonical path without .graphify_root is not fresh", (t) => {
  const { worktree, head } = makeRepo();
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  // Fresh HEAD, valid nodes/edges, directed — but no .graphify_root/manifest.
  writeCanonicalGraph(worktree, head, { root: false, manifest: false });
  const loaded = readGraphifyGraph({ worktree });
  assert.equal(loaded.canonical, true);
  assert.equal(loaded.freshness.valid, false);
  assert.match(loaded.issues.join("\n"), /provenance missing/i);
});

test("a graph missing only manifest.json is not fresh", (t) => {
  const { worktree, head } = makeRepo();
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  writeCanonicalGraph(worktree, head, { root: true, manifest: false });
  const loaded = readGraphifyGraph({ worktree });
  assert.equal(loaded.freshness.valid, false);
  assert.match(loaded.issues.join("\n"), /manifest\.json/i);
});

test("a fully provenance-backed canonical graph is fresh", (t) => {
  const { worktree, head } = makeRepo();
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  writeCanonicalGraph(worktree, head, { root: true, manifest: true });
  const loaded = readGraphifyGraph({ worktree });
  assert.equal(loaded.ok, true, JSON.stringify(loaded.issues));
  assert.equal(loaded.freshness.valid, true);
});

test("the graph provider refuses a caller-selected custom path for trusted decisions", (t) => {
  const { worktree, head } = makeRepo();
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  writeCanonicalGraph(worktree, head, { root: true, manifest: true });
  const command = path.join(worktree, "fake-graphify");
  fs.writeFileSync(command, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(command, 0o755);
  const custom = path.join(worktree, "elsewhere", "graph.json");
  fs.mkdirSync(path.dirname(custom), { recursive: true });
  fs.writeFileSync(custom, JSON.stringify({ directed: true, built_at_commit: head, nodes: [], links: [] }));

  const result = getGraphProvider("graphify").build({
    worktree,
    path: custom,
    graphifyCommand: command,
    graphifyEnv: process.env,
  });
  assert.equal(result.ok, false);
  assert.equal(result.trusted, false);
  assert.match(result.error, /custom graph path rejected/i);
});
