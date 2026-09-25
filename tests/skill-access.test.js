import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const skillsDir = path.join(root, "skills");

const LOADABLE = [
  "nexus-using-nexus",
  "nexus-brainstorming",
  "nexus-writing-plans",
  "nexus-orchestrating",
  "nexus-using-feature-branches",
  "nexus-finishing-a-development-branch",
  "nexus-reconcile",
  "nexus-outcome-memory",
  "nexus-impact-analysis",
];

const RETIRED_DIRS = [
  "using-nexus",
  "brainstorming",
  "writing-plans",
  "orchestrating",
  "impact-analysis",
  "using-feature-branches",
  "finishing-a-development-branch",
  "reconcile",
  "outcome-memory",
];

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, "skill is missing frontmatter");
  return match[1];
}

test("loadable Nexus skills match OpenCode name and frontmatter rules", () => {
  const discovered = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(skillsDir, name, "SKILL.md")))
    .sort();
  assert.deepEqual(discovered, [...LOADABLE].sort());

  for (const id of LOADABLE) {
    const text = fs.readFileSync(path.join(skillsDir, id, "SKILL.md"), "utf8");
    const meta = frontmatter(text);
    const name = meta.match(/^name: (\S+)$/m)?.[1];
    const description = meta.match(/^description: (.+)$/m)?.[1];
    assert.equal(name, id, id);
    assert.equal(name, path.basename(path.join(skillsDir, id)));
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(name.length <= 64, name);
    assert.ok(description && description.length > 0, id);
  }
});

test("deprecated blast-radius is not a loadable skill", () => {
  const dir = path.join(skillsDir, "blast-radius");
  assert.equal(fs.existsSync(path.join(dir, "SKILL.md")), false);
  const note = fs.readFileSync(path.join(dir, "DEPRECATED.md"), "utf8");
  assert.equal(note.startsWith("---"), false);
  assert.match(note, /nexus-impact-analysis/);
});

test("retired skill directories are not discoverable", () => {
  for (const id of RETIRED_DIRS) {
    assert.equal(fs.existsSync(path.join(skillsDir, id)), false, id);
  }
});

test("installer denies nexus skills globally and grants role-scoped allows", () => {
  const install = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  assert.match(install, /"nexus-\*": "deny"/);
  assert.match(install, /\.agent\.orchestrator\.permission\.skill/);
  assert.match(install, /"nexus-\*": "allow"/);
  assert.match(install, /\.agent\.implementer\.permission\.skill/);
  assert.match(install, /\.agent\.reviewer\.permission\.skill/);
  assert.match(install, /"nexus-impact-analysis": "allow"/);
  assert.equal(
    install.includes('.agent["plan-advisor"].permission.skill'),
    false,
  );
  assert.equal(install.includes(".agent.build.permission.skill"), false);
  assert.equal(install.includes(".agent.plan.permission.skill"), false);
});
