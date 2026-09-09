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

test("agent markdown does not pin a model (OpenCode markdown model overrides opencode.json)", () => {
  const agentsDir = path.join(repoRoot, "agents");
  const files = fs.readdirSync(agentsDir).filter((name) => name.endsWith(".md"));
  assert.ok(files.includes("plan-advisor.md"));
  for (const file of files) {
    const body = fs.readFileSync(path.join(agentsDir, file), "utf8");
    const frontmatter = body.split(/^---\s*$/m)[1] || "";
    assert.equal(
      /^\s*model\s*:/m.test(frontmatter),
      false,
      `${file} must not pin model: OpenCode prefers agent markdown over opencode.json`,
    );
  }
});

test("planning-models.json does not use a stale OpenAI mini id or unknown keys", () => {
  const planning = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "config", "planning-models.json"),
      "utf8",
    ),
  );
  assert.equal(planning["plan-advisor"].mode, "subagent");
  assert.equal(planning["plan-advisor"].planning_only, undefined);
  assert.notEqual(planning["plan-advisor"].model, "openai/gpt-5-mini");
  assert.match(planning["plan-advisor"].model, /^(opencode|opencode-go)\//);
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
  assert.deepEqual(keys.sort(), [
    "implementer",
    "orchestrator",
    "plan-advisor",
    "reviewer",
  ]);
  assert.notEqual(
    example.implementer.model.split("/")[0],
    example.reviewer.model.split("/")[0],
    "example should use different provider/family prefixes for implementer vs reviewer",
  );
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

test("published scripts allowlist excludes test-only harnesses", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const publishedScripts = pkg.files.filter((entry) => entry.startsWith("scripts/"));

  assert.deepEqual(publishedScripts, [
    "scripts/ensure-cli-on-path.js",
    "scripts/lib/",
    "scripts/nexus-*.js",
    "scripts/nexus-*.sh",
  ]);
  assert.ok(!publishedScripts.includes("scripts/"));
});
