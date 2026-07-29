import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const blast = path.join(root, "scripts", "nexus-blast.js");

test("blast default output is JSON with uncertainties and dimensions", () => {
  const r = spawnSync(process.execPath, [blast, "--files", "README.md"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const report = JSON.parse(r.stdout);
  assert.ok(report.risk || report.level);
  assert.ok(Array.isArray(report.uncertainties));
  assert.equal(typeof report.dimensions, "object");
  assert.ok(!String(r.stdout).includes("```mermaid"));
});

test("blast --mermaid emits mermaid", () => {
  const r = spawnSync(
    process.execPath,
    [blast, "--files", "README.md", "--mermaid"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.ok(r.stdout.includes("```mermaid"));
});
