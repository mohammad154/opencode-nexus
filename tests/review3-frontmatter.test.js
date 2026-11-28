import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  agentPermission,
  parseAgentFrontmatter,
  parseSimpleYaml,
} from "../scripts/lib/permission-match.js";
import { agentFrontmatterErrors, runPermissionSelfTest } from "../scripts/lib/permission-self-test.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = path.join(repoRoot, "agents");
const AGENT_NAMES = ["orchestrator", "implementer", "reviewer", "plan-advisor"];

function copyAgents() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-agents-"));
  for (const name of fs.readdirSync(agentsDir)) {
    if (name.endsWith(".md")) fs.copyFileSync(path.join(agentsDir, name), path.join(dir, name));
  }
  return dir;
}

test("the YAML subset rejects a repeated key in the same map", () => {
  assert.throws(
    () => parseSimpleYaml('permission:\n  edit:\n    "*": deny\n    "*": ask\n'),
    /duplicate YAML key "\*" at frontmatter line 4/,
  );
});

test("the YAML subset accepts the same key under different parents", () => {
  assert.deepEqual(parseSimpleYaml("a:\n  x: 1\nb:\n  x: 2\n"), { a: { x: "1" }, b: { x: "2" } });
});

test("every shipped agent parses with unique keys", () => {
  assert.deepEqual(agentFrontmatterErrors(agentsDir), []);
});

test("the orchestrator edit floor is one ask rule, not a duplicated key", () => {
  const markdown = fs.readFileSync(path.join(agentsDir, "orchestrator.md"), "utf8");
  const editBlock = markdown.match(/\n  edit:\n((?:    .*\n)+)/)?.[1] || "";
  assert.equal(editBlock.split("\n").filter((line) => /^    "\*":/.test(line)).length, 1);
  assert.equal(agentPermission(markdown).edit["*"], "ask");
});

test("the orchestrator frontmatter still yields a real permission map", () => {
  const frontmatter = parseAgentFrontmatter(fs.readFileSync(path.join(agentsDir, "orchestrator.md"), "utf8"));
  assert.equal(frontmatter.mode, "primary");
  assert.equal(frontmatter.permission.bash["*"], "deny");
  assert.equal(frontmatter.permission.task["*"], "deny");
});

test("the install self-test rejects a duplicate key in any agent file", () => {
  const dir = copyAgents();
  try {
    const file = path.join(dir, "orchestrator.md");
    const original = fs.readFileSync(file, "utf8");
    const duplicated = original.replace(
      '    "*": ask\n    ".opencode/**": allow',
      '    "*": ask\n    "*": deny\n    ".opencode/**": allow',
    );
    assert.notEqual(duplicated, original);
    fs.writeFileSync(file, duplicated);
    const result = runPermissionSelfTest({ agentDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /agent orchestrator\.md frontmatter is invalid: duplicate YAML key "\*"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the install self-test rejects a duplicate key in a non-orchestrator agent", () => {
  const dir = copyAgents();
  try {
    const file = path.join(dir, "implementer.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('    "*": allow\n', '    "*": allow\n    "*": deny\n'));
    const result = runPermissionSelfTest({ agentDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /implementer\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const OPENCODE_BIN = process.env.NEXUS_OPENCODE_BIN || "";

test(
  "OpenCode itself loads every shipped agent with the same permission rules",
  { skip: OPENCODE_BIN ? false : "set NEXUS_OPENCODE_BIN to an OpenCode binary to run" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-opencode-agents-"));
    try {
      const configDir = path.join(root, "cfg");
      fs.mkdirSync(path.join(configDir, "agents"), { recursive: true });
      for (const name of AGENT_NAMES) {
        fs.copyFileSync(path.join(agentsDir, `${name}.md`), path.join(configDir, "agents", `${name}.md`));
      }
      const project = path.join(root, "project");
      fs.mkdirSync(project);
      const env = {
        ...process.env,
        HOME: path.join(root, "home"),
        XDG_CONFIG_HOME: path.join(root, "xdg"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        OPENCODE_CONFIG_DIR: configDir,
      };
      const result = spawnSync(OPENCODE_BIN, ["debug", "config"], {
        cwd: project,
        env,
        encoding: "utf8",
        timeout: 120000,
      });
      assert.equal(result.status, 0, result.stderr);
      const config = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
      for (const name of AGENT_NAMES) {
        const loaded = config.agent?.[name];
        assert.ok(loaded, `OpenCode did not load agent ${name}`);
        assert.doesNotMatch(String(loaded.prompt || ""), /^---/, `${name} frontmatter was not parsed`);
        const expected = agentPermission(fs.readFileSync(path.join(agentsDir, `${name}.md`), "utf8"));
        for (const block of ["edit", "bash"]) {
          if (!expected[block]) continue;
          for (const [pattern, action] of Object.entries(expected[block])) {
            assert.equal(
              loaded.permission?.[block]?.[pattern],
              action,
              `${name} ${block} rule ${JSON.stringify(pattern)} differs in OpenCode`,
            );
          }
        }
      }
      assert.equal(config.agent.orchestrator.permission.edit["*"], "ask");
      assert.equal(config.agent.orchestrator.permission.bash["*"], "deny");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
