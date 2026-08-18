import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../../scripts/lib/classify.js";

// Regression: a safer declared change_class must never suppress a hard path
// signal (auth/security, migration, credential handling). The Git diff is the
// source of truth. See fix #1.

const BYPASS_ATTEMPTS = [
  {
    name: "one_file_internal cannot hide an auth file",
    input: { changeClass: "one_file_internal", changed_files: ["src/auth/session.js"] },
    flag: "security",
  },
  {
    name: "documentation cannot hide a migration file",
    input: { changeClass: "documentation", changed_files: ["db/migrations/001_add_users.sql"] },
    flag: "migration",
  },
  {
    name: "formatting cannot hide an oauth file",
    input: { changeClass: "formatting", changed_files: ["src/oauth/token.ts"] },
    flag: "security",
  },
  {
    name: "test-only cannot hide a bare migration file",
    input: { changeClass: "test-only", changed_files: ["migrations/002.sql"] },
    flag: "migration",
  },
  {
    name: "documentation cannot hide a credentials/secrets file",
    input: { changeClass: "documentation", changed_files: ["config/secrets/prod.env"] },
    flag: "credential_handling",
  },
];

for (const attempt of BYPASS_ATTEMPTS) {
  test(attempt.name, () => {
    const r = classify({
      filesChanged: 1,
      estimatedLines: 5,
      ...attempt.input,
    });
    assert.equal(r.profile, "strict", `${attempt.name} profile`);
    assert.equal(r.review_level, "dual", `${attempt.name} review`);
    assert.equal(r.direct_eligible, false, `${attempt.name} direct`);
    assert.ok(
      r.semantic_signals.includes(attempt.flag),
      `${attempt.name} expected signal ${attempt.flag}, got ${JSON.stringify(r.semantic_signals)}`,
    );
    assert.ok(
      r.hard_triggers.includes(attempt.flag),
      `${attempt.name} expected hard trigger ${attempt.flag}`,
    );
  });
}

test("genuinely safe docs/formatting are unaffected by the hard-signal guard", () => {
  const docs = classify({
    filesChanged: 1,
    estimatedLines: 10,
    changeClass: "documentation",
    documentationOnly: true,
    changed_files: ["README.md"],
  });
  assert.equal(docs.review_level, "none");
  assert.deepEqual(docs.hard_triggers, []);

  const fmt = classify({
    filesChanged: 1,
    estimatedLines: 10,
    changeClass: "formatting",
    formattingOnly: true,
    changed_files: ["src/util/format-only.js"],
  });
  assert.deepEqual(fmt.hard_triggers, []);
});

test("soft signals remain suppressible for declared-safe classes", () => {
  // A lockfile dependency-update signal is a soft signal; a documentation
  // class over an all-docs set should not force it. But it MUST still fire
  // when the class is not declared-safe.
  const soft = classify({
    filesChanged: 1,
    estimatedLines: 10,
    changeClass: "small-feature-with-tests",
    changed_files: ["package-lock.json"],
  });
  assert.ok(soft.semantic_signals.includes("dependency_update"));
});
