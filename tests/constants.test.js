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

test("orchestrator is primary; all other canonical agents are subagents", () => {
  for (const agent of CANONICAL_AGENTS) {
    const body = fs.readFileSync(
      path.join(repoRoot, "agents", `${agent}.md`),
      "utf8",
    );
    assert.ok(
      body.startsWith("---\n"),
      `${agent}.md must start with YAML frontmatter so OpenCode can read mode`,
    );
    const expected =
      agent === "orchestrator" ? "mode: primary" : "mode: subagent";
    assert.ok(
      new RegExp(`^${expected}$`, "m").test(body),
      `${agent}.md must declare ${expected} (OpenCode defaults missing mode to primary)`,
    );
  }
});

test("optional agents declare mode: subagent so they never appear as primary", () => {
  for (const agent of OPTIONAL_AGENTS) {
    const body = fs.readFileSync(
      path.join(repoRoot, "agents", `${agent}.md`),
      "utf8",
    );
    assert.ok(
      body.startsWith("---\n"),
      `${agent}.md must start with YAML frontmatter so OpenCode can read mode`,
    );
    assert.ok(
      /^mode: subagent$/m.test(body),
      `${agent}.md must declare mode: subagent`,
    );
  }
});
