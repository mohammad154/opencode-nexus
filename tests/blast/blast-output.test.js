/**
 * Legacy `nexus blast` is a thin alias to the Impact Engine (V4).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const blast = path.join(root, "scripts", "nexus-blast.js");

test("nexus-blast aliases to impact engine JSON", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-blast-alias-"));
  spawnSync("git", ["init", "-q"], { cwd: fixture });
  spawnSync("git", ["config", "user.email", "t@ex.com"], { cwd: fixture });
  spawnSync("git", ["config", "user.name", "t"], { cwd: fixture });
  fs.writeFileSync(path.join(fixture, "a.js"), "export const a = 1;\n");
  spawnSync("git", ["add", "."], { cwd: fixture });
  spawnSync("git", ["commit", "-m", "i", "-q"], { cwd: fixture });
  fs.writeFileSync(path.join(fixture, "a.js"), "export const a = 2;\n");

  const r = spawnSync(process.execPath, [blast, "--json", "--worktree", fixture], {
    encoding: "utf8",
    cwd: fixture,
  });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.provider, "nexus-impact");
  assert.ok(report.risk);
  assert.equal(typeof report.confidence, "number");
  fs.rmSync(fixture, { recursive: true, force: true });
});
