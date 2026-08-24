import test from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  reclassifyAfterBlast,
  DEFAULT_V2,
} from "../../scripts/lib/classify.js";

function expectDecision(result, expected, label) {
  if (expected.profile) {
    assert.equal(result.profile, expected.profile, `${label} profile`);
  }
  if (expected.review_level) {
    assert.equal(result.review_level, expected.review_level, `${label} review`);
  }
  if (expected.notProfile) {
    assert.notEqual(result.profile, expected.notProfile, `${label} not ${expected.notProfile}`);
  }
  if (expected.maxProfile) {
    const rank = { fast: 0, balanced: 1, strict: 2 };
    assert.ok(
      rank[result.profile] <= rank[expected.maxProfile],
      `${label} profile ${result.profile} should be at most ${expected.maxProfile}`,
    );
  }
  if (expected.minReview) {
    const rank = { none: 0, unified: 1, dual: 2 };
    assert.ok(
      rank[result.review_level] >= rank[expected.minReview],
      `${label} review ${result.review_level} should be at least ${expected.minReview}`,
    );
  }
}

const SCENARIOS = [
  {
    name: "docs typo → fast / none",
    input: {
      filesChanged: 1,
      estimatedLines: 2,
      changeClass: "documentation",
      documentationOnly: true,
      focusedValidation: true,
      changed_files: ["README.md"],
    },
    expected: { profile: "fast", review_level: "none" },
  },
  {
    name: "tiny private helper refactor → fast / unified",
    input: {
      filesChanged: 1,
      estimatedLines: 18,
      changeClass: "small-internal-refactor",
      oneFileInternal: true,
      focusedValidation: true,
      changed_files: ["src/internal/helper.js"],
    },
    expected: { profile: "fast", review_level: "unified" },
  },
  {
    name: "normal feature + tests → balanced / unified",
    input: {
      filesChanged: 4,
      estimatedLines: 90,
      changeClass: "small-feature-with-tests",
      changed_files: ["src/a.js", "src/b.js", "src/c.js", "tests/a.test.js"],
      changed_test_files: ["tests/a.test.js"],
    },
    expected: { profile: "balanced", review_level: "unified" },
  },
  {
    name: "1-line authentication change → strict / dual",
    input: {
      filesChanged: 1,
      estimatedLines: 1,
      changeClass: "authentication-security",
      changed_files: ["src/auth/login.ts"],
    },
    expected: { profile: "strict", review_level: "dual" },
  },
  {
    name: "public API signature change → strict / dual",
    input: {
      filesChanged: 1,
      estimatedLines: 8,
      changeClass: "public-api",
      changed_exported_symbols: ["createClient"],
    },
    expected: { profile: "strict", review_level: "dual" },
  },
  {
    name: "DB migration → strict / dual",
    input: {
      filesChanged: 1,
      estimatedLines: 40,
      changeClass: "database-migration",
      changed_files: ["db/migrations/20260814_users.sql"],
    },
    expected: { profile: "strict", review_level: "dual" },
  },
  {
    name: "300-line test fixture rename is not strict just because large",
    input: {
      filesChanged: 2,
      estimatedLines: 300,
      changeClass: "test-only",
      changed_files: [
        "tests/fixtures/old-users.json",
        "tests/fixtures/new-users.json",
      ],
      changed_test_files: [
        "tests/fixtures/old-users.json",
        "tests/fixtures/new-users.json",
      ],
    },
    expected: { profile: "balanced", notProfile: "strict" },
  },
  {
    name: "stale impact data → never fast",
    input: {
      filesChanged: 1,
      estimatedLines: 12,
      changeClass: "small-internal-refactor",
      oneFileInternal: true,
      focusedValidation: true,
      graph_stale: true,
    },
    expected: { notProfile: "fast", maxProfile: "strict" },
  },
  {
    name: "diff evidence missing → never fast",
    input: {
      filesChanged: 1,
      estimatedLines: 8,
      changeClass: "small-internal-refactor",
      oneFileInternal: true,
      evidence_source: "explicit-input-fallback",
      diff_requested: true,
      diff_available: false,
    },
    expected: { notProfile: "fast" },
  },
  {
    name: "exported symbol + 17 direct callers → strict / dual",
    input: {
      filesChanged: 1,
      estimatedLines: 20,
      changeClass: "small-feature-with-tests",
      changed_exported_symbols: ["parseToken"],
      directCallers: 17,
      affected_packages: ["packages/core", "packages/api"],
    },
    expected: { profile: "strict", review_level: "dual" },
  },
  {
    name: "one direct caller keeps a private helper low risk",
    input: {
      filesChanged: 1,
      estimatedLines: 14,
      changeClass: "small-internal-refactor",
      oneFileInternal: true,
      focusedValidation: true,
      directCallers: 1,
      transitiveImpact: 1,
    },
    expected: { profile: "fast", review_level: "unified" },
  },
  {
    name: "auth path heuristic is strict even for a one-line edit",
    input: {
      filesChanged: 1,
      estimatedLines: 1,
      changeClass: "small-feature-with-tests",
      changed_files: ["src/auth/session.ts"],
      changed_test_files: ["tests/auth/session.test.ts"],
    },
    expected: { profile: "strict", review_level: "dual" },
  },
  {
    name: "dependency lockfile update stays balanced",
    input: {
      filesChanged: 1,
      estimatedLines: 40,
      changeClass: "small-feature-with-tests",
      changed_files: ["package-lock.json"],
      dependency_update: true,
    },
    expected: { profile: "balanced", notProfile: "strict" },
  },
  {
    name: "config/schema/protocol change is semantic, not size-driven",
    input: {
      filesChanged: 1,
      estimatedLines: 12,
      changeClass: "small-feature-with-tests",
      changed_files: ["openapi.yaml"],
      config_schema_protocol: true,
      changed_test_files: ["tests/openapi.test.js"],
    },
    expected: { profile: "balanced" },
  },
  {
    name: "cross-package + missing tests is enough for strict",
    input: {
      filesChanged: 3,
      estimatedLines: 40,
      changeClass: "small-feature-with-tests",
      cross_package_change: true,
      missing_tests: true,
      exported_symbol_change: true,
    },
    expected: { profile: "strict", minReview: "unified" },
  },
  {
    name: "concurrency/async behavior is a strong semantic signal",
    input: {
      filesChanged: 1,
      estimatedLines: 25,
      changeClass: "small-feature-with-tests",
      concurrency_async: true,
      changed_files: ["src/workers/queue.js"],
      changed_test_files: ["tests/workers/queue.test.js"],
    },
    expected: { profile: "balanced" },
  },
  {
    name: "database storage behavior without a migration stays off hard-strict",
    input: {
      filesChanged: 1,
      estimatedLines: 30,
      changeClass: "small-feature-with-tests",
      database_storage: true,
      changed_files: ["src/repositories/users.js"],
      changed_test_files: ["tests/repositories/users.test.js"],
    },
    expected: { profile: "balanced", notProfile: "strict" },
  },
  {
    name: "blast incomplete never authorizes fast",
    input: {
      filesChanged: 1,
      estimatedLines: 10,
      changeClass: "small-internal-refactor",
      oneFileInternal: true,
      blast_incomplete: true,
      classification_stage: "post-blast",
    },
    expected: { notProfile: "fast" },
  },
  {
    name: "confidence gate can force STRICT / reconcile",
    input: {
      filesChanged: 1,
      estimatedLines: 8,
      changeClass: "small-internal-refactor",
      oneFileInternal: true,
    },
    options: {
      rules: {
        ...DEFAULT_V2,
        confidence_gates: { fast_min: 0.85, balanced_min: 0.99 },
      },
    },
    expected: { profile: "strict" },
  },
  {
    name: "classification always explains the decision",
    input: {
      filesChanged: 1,
      estimatedLines: 10,
      changeClass: "public-api",
    },
    expected: { profile: "strict", review_level: "dual" },
    explain: true,
  },
];

for (const scenario of SCENARIOS) {
  test(scenario.name, () => {
    const result = classify(scenario.input, scenario.options || {});
    expectDecision(result, scenario.expected, scenario.name);
    if (scenario.expected.notProfile === "fast") {
      assert.notEqual(result.profile, "fast");
    }
    if (scenario.explain) {
      assert.ok(result.reasons.length > 0);
      assert.equal(typeof result.risk_score, "number");
      assert.equal(typeof result.confidence, "number");
      assert.ok(["trusted", "partial", "unknown"].includes(result.evidence_quality));
      assert.equal(result.stage, "pre-implementation");
    }
  });
}

test("HIGH blast discovered later escalates review independently of execution profile", () => {
  const previous = classify({
    filesChanged: 3,
    estimatedLines: 80,
    changeClass: "small-feature-with-tests",
    changed_files: ["src/a.js", "src/b.js", "tests/a.test.js"],
    changed_test_files: ["tests/a.test.js"],
  });
  assert.equal(previous.profile, "balanced");
  assert.equal(previous.review_level, "unified");

  const next = reclassifyAfterBlast(previous, {
    risk: "HIGH",
    level: "HIGH",
    score: 18,
    analysis_quality: "PRECISE",
    graph_quality: "PRECISE",
    graph_freshness: { valid: true },
    analysis_complete: true,
    trusted: true,
  });
  assert.equal(next.stage, "post-blast");
  assert.equal(next.profile, "balanced");
  assert.equal(next.review_level, "dual");
  assert.equal(next.execution_mode, "delegated");
  assert.match(next.reasons.join("\n"), /HIGH blast|dual review|blast risk HIGH/i);
});

test("HIGH blast plus public entry point and many callers becomes strict", () => {
  const previous = classify({
    filesChanged: 1,
    estimatedLines: 12,
    changeClass: "small-feature-with-tests",
    changed_exported_symbols: ["authenticate"],
    changed_files: ["src/api/authenticate.js"],
    changed_test_files: ["tests/api/authenticate.test.js"],
  });
  const next = reclassifyAfterBlast(previous, {
    risk: "HIGH",
    level: "HIGH",
    direct_dependents: Array.from({ length: 17 }, (_, i) => `src/caller-${i}.js`),
    affected_packages: ["packages/api", "packages/web"],
    analysis_quality: "PRECISE",
    graph_quality: "PRECISE",
    graph_freshness: { valid: true },
    trusted: true,
  });
  assert.equal(next.profile, "strict");
  assert.equal(next.review_level, "dual");
  assert.ok(next.reasons.some((reason) => /17 direct callers/.test(reason)));
  assert.ok(next.reasons.some((reason) => /public exported symbol/.test(reason)));
});

test("post-blast reclassification never downgrades a stricter prior decision", () => {
  const previous = classify({
    filesChanged: 1,
    estimatedLines: 4,
    changeClass: "authentication-security",
  });
  const next = reclassifyAfterBlast(previous, {
    risk: "LOW",
    level: "LOW",
    analysis_quality: "PRECISE",
    graph_quality: "PRECISE",
    graph_freshness: { valid: true },
    trusted: true,
    direct_dependents: ["src/only.js"],
  });
  assert.equal(next.profile, "strict");
  assert.equal(next.review_level, "dual");
  assert.equal(next.direct_eligible, false);
});

test("UNKNOWN blast cannot remain fast", () => {
  const previous = classify({
    filesChanged: 1,
    estimatedLines: 10,
    changeClass: "small-internal-refactor",
    oneFileInternal: true,
    focusedValidation: true,
  });
  assert.equal(previous.profile, "fast");
  const next = reclassifyAfterBlast(previous, {
    risk: "UNKNOWN",
    analysis_quality: "UNKNOWN",
    graph_quality: "UNKNOWN",
    analysis_complete: false,
  });
  assert.notEqual(next.profile, "fast");
  assert.equal(next.evidence_quality, "unknown");
  assert.equal(next.direct_eligible, false);
});

test("large non-security feature stays off strict when only size is high", () => {
  const result = classify({
    filesChanged: 12,
    estimatedLines: 420,
    changeClass: "small-feature-with-tests",
    changed_files: [
      "src/a.js",
      "src/b.js",
      "src/c.js",
      "src/d.js",
      "src/e.js",
      "src/f.js",
      "src/g.js",
      "src/h.js",
      "src/i.js",
      "src/j.js",
      "src/k.js",
      "tests/a.test.js",
    ],
    changed_test_files: ["tests/a.test.js"],
  });
  assert.equal(result.profile, "balanced");
  assert.ok(result.risk_score < DEFAULT_V2.thresholds.strict_min);
});
