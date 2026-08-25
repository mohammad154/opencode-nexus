import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_AGENTS, OPTIONAL_AGENTS } from "../scripts/lib/constants.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CANONICAL_AGENTS contains exactly the 3 V5 agents in order and is frozen", () => {
  const expected = ["orchestrator", "implementer", "reviewer"];
  assert.deepEqual(Array.from(CANONICAL_AGENTS), expected);
  assert.ok(Object.isFrozen(CANONICAL_AGENTS));
});

test("OPTIONAL_AGENTS is empty in V5 and frozen", () => {
  assert.deepEqual(Array.from(OPTIONAL_AGENTS), []);
  assert.ok(Object.isFrozen(OPTIONAL_AGENTS));
});

test("all canonical agents have corresponding markdown files in agents/", () => {
  for (const agent of CANONICAL_AGENTS) {
    const agentFile = path.join(repoRoot, "agents", `${agent}.md`);
    assert.ok(
      fs.existsSync(agentFile),
      `Expected agent definition file ${agentFile} to exist`,
    );
  }
});

test("orchestrator is primary; implementer and reviewer are subagents", () => {
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

test("default-models.json declares modes so json-only agent entries stay out of the primary picker", () => {
  const models = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "config", "default-models.json"),
      "utf8",
    ),
  );
  assert.equal(models.orchestrator.mode, "primary");
  assert.equal(models.implementer.mode, "subagent");
  assert.equal(models.reviewer.mode, "subagent");
  assert.equal(
    Object.keys(models)
      .filter((k) => !k.startsWith("_"))
      .sort()
      .join(","),
    "implementer,orchestrator,reviewer",
  );
  assert.notEqual(models.implementer.model, models.reviewer.model);
  assert.ok(
    typeof models._reviewer_diversity_note === "string" &&
      models._reviewer_diversity_note.length > 0,
  );
});

test("models.example.json is V5-only and does not reintroduce retired agents", () => {
  const example = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "config", "models.example.json"),
      "utf8",
    ),
  );
  const keys = Object.keys(example).filter((k) => !k.startsWith("_"));
  assert.deepEqual(keys.sort(), ["implementer", "orchestrator", "reviewer"]);
  for (const retired of [
    "unified-reviewer",
    "spec-reviewer",
    "code-reviewer",
    "reconciler",
    "diagnostician",
    "blast-analyzer",
  ]) {
    assert.equal(
      example[retired],
      undefined,
      `example must not include ${retired}`,
    );
  }
});
