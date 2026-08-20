import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ESTIMATOR = path.join(ROOT, "scripts/nexus-estimate-calls.js");

function estimate(...args) {
  const output = execFileSync(process.execPath, [ESTIMATOR, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(output.slice(output.indexOf("{\n")));
}

test("V5 estimate: tasks * (implementer + reviewer)", () => {
  const result = estimate("--tasks", "3");
  assert.equal(result.workflow, "default");
  assert.equal(result.calls.implementer, 3);
  assert.equal(result.calls.reviewer, 3);
  assert.equal(result.calls.total, 6);
});

test("V5 estimate: fix loops add another implementer+reviewer pair each", () => {
  const result = estimate("--tasks", "2", "--fix-loops", "1");
  assert.equal(result.calls.implementer, 3);
  assert.equal(result.calls.reviewer, 3);
  assert.equal(result.calls.total, 6);
});

test("V5 estimate ignores legacy --profile flags without error", () => {
  const result = estimate("--tasks", "1", "--profile", "strict");
  assert.equal(result.calls.total, 2);
});
