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

test("documentation and direct work use only implementer calls", () => {
  for (const profile of ["fast", "balanced", "strict"]) {
    for (const extra of [["--class", "documentation"], ["--direct"]]) {
      const result = estimate("--tasks", "2", "--units", "1", "--profile", profile, ...extra);
      const count = profile === "strict" ? 2 : 1;
      assert.equal(result.estimated_agent_calls, count);
      assert.deepEqual(result.breakdown, {
        implementer: count,
        unified_reviewer: 0,
        spec_reviewer: 0,
        code_reviewer: 0,
        cleanup_agent: 0,
        scripts: "graph/blast/cleanup",
      });
    }
  }
});

test("normal low-risk work uses implementer plus unified reviewer", () => {
  for (const profile of ["fast", "balanced"]) {
    const result = estimate("--tasks", "5", "--units", "2", "--profile", profile);
    assert.equal(result.estimated_agent_calls, 4);
    assert.equal(result.breakdown.implementer, 2);
    assert.equal(result.breakdown.unified_reviewer, 2);
    assert.equal(result.breakdown.spec_reviewer, 0);
    assert.equal(result.breakdown.code_reviewer, 0);
  }
});

test("high-risk and strict work use spec and code reviewers", () => {
  const highRisk = estimate(
    "--tasks", "5", "--units", "2", "--profile", "balanced",
    "--class", "public-api",
  );
  assert.equal(highRisk.estimated_agent_calls, 6);
  assert.equal(highRisk.breakdown.unified_reviewer, 0);
  assert.equal(highRisk.breakdown.spec_reviewer, 2);
  assert.equal(highRisk.breakdown.code_reviewer, 2);

  const strict = estimate("--tasks", "5", "--units", "2", "--profile", "strict");
  assert.equal(strict.estimated_agent_calls, 15);
  assert.equal(strict.breakdown.implementer, 5);
  assert.equal(strict.breakdown.spec_reviewer, 5);
  assert.equal(strict.breakdown.code_reviewer, 5);
});

test("legacy JSON aliases remain consistent", () => {
  const result = estimate("--tasks", "3", "--profile", "balanced");
  assert.equal(result.estimated_calls, result.estimated_agent_calls);
  assert.equal(result.strict_equivalent_calls, result.strict_equivalent_agent_calls);
  assert.equal(result.savings, result.saved_agent_calls);
});
