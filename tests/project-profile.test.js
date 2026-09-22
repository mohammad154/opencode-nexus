import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJECT_PROFILE_CACHE_PATH,
  PROJECT_PROFILE_FORBIDDEN_AUTHORITY,
  PROJECT_PROFILE_VERSION,
  buildProjectProfile,
  loadProjectProfile,
  profileSourceFiles,
  resolveProjectProfile,
} from "../scripts/lib/project-profile.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture({ withCi = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-profile-"));
  roots.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "profile-fixture",
        type: "module",
        scripts: { test: "node --test", lint: "eslint .", build: "tsc -p ." },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# agents\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "foo.js"), "export const foo = 1;\n");
  if (withCi) {
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
  }
  return root;
}

test("profile caches repository-level facts, not task conclusions", () => {
  const root = fixture();
  const profile = buildProjectProfile(root);
  assert.equal(profile.version, PROJECT_PROFILE_VERSION);
  assert.equal(profile.advisory, true);
  assert.deepEqual(profile.authorizes, []);
  assert.equal(profile.facts.ecosystem, "node");
  assert.equal(profile.facts.package_manager, "npm");
  assert.equal(profile.facts.commands.test, "npm test");
  assert.equal(profile.facts.commands.lint, "npm run lint");
  assert.deepEqual(profile.facts.ci_config_paths, [".github/workflows/ci.yml"]);
  assert.deepEqual(profile.facts.guide_paths, ["AGENTS.md"]);
  assert.equal(profile.facts.root_config.name, "profile-fixture");
  assert.ok(profile.identity?.startsWith("sha256:"));

  // No task-specific semantic conclusion may be cached.
  const serialized = JSON.stringify(profile);
  for (const forbidden of [
    "target_file",
    "exemplar",
    "acceptance",
    "execution_unit",
    "plan",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("first resolve rebuilds and writes the cache; second resolve hits it", () => {
  const root = fixture();
  const first = resolveProjectProfile(root);
  assert.equal(first.cache_hit, false);
  assert.equal(first.rebuilt, true);
  assert.equal(first.cache_written, true);
  assert.ok(fs.existsSync(path.join(root, PROJECT_PROFILE_CACHE_PATH)));

  const second = resolveProjectProfile(root);
  assert.equal(second.cache_hit, true);
  assert.equal(second.rebuilt, false);
  assert.equal(second.reason, "IDENTITY_MATCH");
  assert.equal(second.profile.identity, first.profile.identity);
  assert.equal(second.profile.generated_at, first.profile.generated_at);
});

test("source content decides invalidation, not HEAD or unrelated code", () => {
  const root = fixture();
  resolveProjectProfile(root);

  // An unrelated production file changes nothing about repository-level facts.
  fs.writeFileSync(path.join(root, "src", "foo.js"), "export const foo = 2;\n");
  assert.equal(resolveProjectProfile(root).cache_hit, true);

  // Manifest content is part of the identity.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  pkg.scripts.typecheck = "tsc --noEmit";
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  const afterManifest = resolveProjectProfile(root);
  assert.equal(afterManifest.cache_hit, false);
  assert.equal(afterManifest.reason, "IDENTITY_CHANGED");
  assert.equal(afterManifest.profile.facts.commands.typecheck, "npm run typecheck");

  // CI content is part of the identity.
  fs.writeFileSync(
    path.join(root, ".github", "workflows", "ci.yml"),
    "name: ci\njobs: {}\n",
  );
  assert.equal(resolveProjectProfile(root).reason, "IDENTITY_CHANGED");

  // An agent guide is part of the identity.
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# agents\nrule\n");
  assert.equal(resolveProjectProfile(root).reason, "IDENTITY_CHANGED");
  assert.equal(resolveProjectProfile(root).cache_hit, true);
});

test("a newly added candidate source invalidates the profile", () => {
  const root = fixture();
  resolveProjectProfile(root);
  assert.equal(resolveProjectProfile(root).cache_hit, true);
  fs.writeFileSync(path.join(root, "CONTRIBUTING.md"), "# contributing\n");
  const rebuilt = resolveProjectProfile(root);
  assert.equal(rebuilt.cache_hit, false);
  assert.ok(rebuilt.profile.facts.guide_paths.includes("CONTRIBUTING.md"));
});

test("a tampered or version-shifted cache is discarded, never repaired", () => {
  const root = fixture();
  const resolved = resolveProjectProfile(root);
  const cacheFile = path.join(root, PROJECT_PROFILE_CACHE_PATH);

  const forged = { ...resolved.profile, identity: "sha256:deadbeef" };
  fs.writeFileSync(cacheFile, JSON.stringify(forged));
  assert.equal(loadProjectProfile(root).ok, false);
  assert.equal(loadProjectProfile(root).reason, "IDENTITY_CHANGED");

  fs.writeFileSync(
    cacheFile,
    JSON.stringify({ ...resolved.profile, version: "nexus-project-profile/0" }),
  );
  assert.equal(loadProjectProfile(root).reason, "VERSION_CHANGED");

  fs.writeFileSync(cacheFile, "not json");
  assert.equal(loadProjectProfile(root).reason, "CACHE_UNREADABLE");
  assert.equal(resolveProjectProfile(root).rebuilt, true);
});

test("resolve emits PR5 telemetry for both cache hit and rebuild", () => {
  const root = fixture();
  const events = [];
  const telemetry = { emit: (event) => events.push(event) };
  resolveProjectProfile(root, { telemetry });
  resolveProjectProfile(root, { telemetry });
  assert.deepEqual(
    events.map((event) => event.event),
    ["project_profile", "project_profile"],
  );
  assert.equal(events[0].project_profile_rebuild, 1);
  assert.equal(events[0].project_profile_cache_hit, 0);
  assert.equal(events[1].project_profile_cache_hit, 1);
  assert.equal(events[1].project_profile_rebuild, 0);
  for (const event of events) {
    assert.equal(typeof event.project_profile_duration_ms, "number");
  }
});

test("the profile is advisory: no gate module may import it", () => {
  const gateModules = [
    "scripts/lib/state-machine.js",
    "scripts/lib/plan-check.js",
    "scripts/lib/verification-lifecycle.js",
    "scripts/lib/run-gate.js",
    "scripts/lib/review-package.js",
    "scripts/lib/scope-lock.js",
  ];
  for (const relative of gateModules) {
    const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.equal(
      source.includes("project-profile"),
      false,
      `${relative} must not depend on the advisory project profile`,
    );
  }
  assert.deepEqual(
    [...PROJECT_PROFILE_FORBIDDEN_AUTHORITY],
    ["PLANNED", "TASK_IMPACT_READY", "VERIFYING", "REVIEWING", "COMPLETED"],
  );
});

test("declared source list is stable, sorted, and includes absent candidates", () => {
  const root = fixture({ withCi: false });
  const sources = profileSourceFiles(root);
  assert.deepEqual(sources, [...sources].sort());
  assert.ok(sources.includes("package.json"));
  assert.ok(sources.includes("CLAUDE.md"), "absent candidates stay in the identity");
  assert.equal(new Set(sources).size, sources.length);
});
