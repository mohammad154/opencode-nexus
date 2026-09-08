import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

test("README documents the fixed V5 workflow", () => {
  assert.match(readme, /V5 installs only `orchestrator`, `implementer`, and `reviewer`/);
  assert.match(readme, /V5 has one fixed workflow/);
  assert.match(readme, /Every task receives a task-scoped review package and reviewer/);
  assert.match(readme, /final review package and reviewer examine the whole run/);
  assert.doesNotMatch(readme, /--with-optional-agents/);
  assert.doesNotMatch(readme, /--profile balanced/);
  assert.doesNotMatch(readme, /Direct \(no-dispatch\)/);
  assert.doesNotMatch(readme, /V4 workflow reference/);
});
