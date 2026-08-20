import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_AGENTS, OPTIONAL_AGENTS } from "../scripts/lib/constants.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CANONICAL_AGENTS contains exactly the 8 canonical agents in order and is frozen", () => {
  const expected = [
    "orchestrator",
    "implementer",
    "diagnostician",
    "unified-reviewer",
    "spec-reviewer",
    "code-reviewer",
    "integration-reviewer",
    "reconciler",
  ];
  assert.deepEqual(Array.from(CANONICAL_AGENTS), expected);
  assert.ok(Object.isFrozen(CANONICAL_AGENTS));
});

test("OPTIONAL_AGENTS contains blast-analyzer and is frozen", () => {
  assert.deepEqual(Array.from(OPTIONAL_AGENTS), ["blast-analyzer"]);
  assert.ok(Object.isFrozen(OPTIONAL_AGENTS));
});

test("all canonical and optional agents have corresponding markdown files in agents/", () => {
  for (const agent of [...CANONICAL_AGENTS, ...OPTIONAL_AGENTS]) {
    const agentFile = path.join(repoRoot, "agents", `${agent}.md`);
    assert.ok(
      fs.existsSync(agentFile),
      `Expected agent definition file ${agentFile} to exist`,
    );
  }
});
