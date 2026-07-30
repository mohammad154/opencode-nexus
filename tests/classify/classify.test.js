import test from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  migrateV1RulesToV2,
  loadClassificationRules,
  DEFAULT_V2,
} from "../../scripts/lib/classify.js";

test("large non-security change is not fast (OR bug fix)", () => {
  const r = classify({
    filesChanged: 10,
    estimatedLines: 400,
    changeClass: "small-feature-with-tests",
  });
  assert.notEqual(r.profile, "fast");
  assert.ok(r.risk_score > 1);
  assert.equal(r.execution_mode, "delegated");
});

test("security hard trigger → strict dual", () => {
  const r = classify({
    filesChanged: 1,
    estimatedLines: 10,
    securitySensitive: true,
  });
  assert.equal(r.profile, "strict");
  assert.equal(r.review_level, "dual");
  assert.equal(r.direct_eligible, false);
});

test("docs-only tiny change can be fast", () => {
  const r = classify({
    filesChanged: 1,
    estimatedLines: 20,
    documentationOnly: true,
    changeClass: "documentation",
    focusedValidation: true,
  });
  assert.equal(r.profile, "fast");
  assert.ok(r.reasons.length > 0);
});

test("direct path denied when confidence low or gates fail", () => {
  const r = classify({
    filesChanged: 1,
    estimatedLines: 5,
    changeClass: "one_file_internal",
    oneFileInternal: true,
    focusedValidation: false,
  });
  // require_focused_validation: true and no focused validation → not direct
  assert.equal(r.direct_eligible, false);
  assert.equal(r.execution_mode, "delegated");
});

test("direct path denied when confidence below min", () => {
  const r = classify(
    {
      filesChanged: 1,
      estimatedLines: 5,
      changeClass: "documentation",
      documentationOnly: true,
      focusedValidation: true,
    },
    {
      rules: {
        ...loadClassificationRules(),
        direct_path: {
          ...loadClassificationRules().direct_path,
          min_confidence: 0.99,
        },
      },
    },
  );
  assert.equal(r.direct_eligible, false);
  assert.equal(r.execution_mode, "delegated");
});

test("direct path allowed for narrowly gated docs", () => {
  const r = classify({
    filesChanged: 1,
    estimatedLines: 10,
    changeClass: "documentation",
    documentationOnly: true,
    focusedValidation: true,
    evidence_source: "git-diff",
    diff_verified: true,
    diff_available: true,
    diff_clean: false,
  });
  assert.equal(r.direct_eligible, true);
  assert.equal(r.execution_mode, "direct");
  assert.equal(r.review_level, "none");
});

test("v1 rules migrate and keep balanced default", () => {
  const v2 = migrateV1RulesToV2({
    default: "balanced",
    strictIf: ["securitySensitive", "publicApi"],
    fastIf: { or: { filesChangedMax: 2 } },
  });
  assert.equal(v2.version, 2);
  assert.equal(v2.default, "balanced");
  assert.ok(v2.hard_strict_triggers.includes("security"));
  assert.ok(v2.hard_strict_triggers.includes("public_api"));
});

test("loadClassificationRules reads repo config v2", () => {
  const rules = loadClassificationRules();
  assert.equal(rules.version, 2);
  assert.equal(rules.default, "balanced");
  assert.equal(rules.thresholds.fast_max, DEFAULT_V2.thresholds.fast_max);
});

test("ordinary 3-file change stays balanced not fast", () => {
  const r = classify({
    filesChanged: 3,
    estimatedLines: 80,
    changeClass: "small-feature-with-tests",
  });
  assert.equal(r.profile, "balanced");
});

test("user-api class alone is strict dual", () => {
  const r = classify({
    filesChanged: 1,
    estimatedLines: 10,
    changeClass: "public-api",
  });
  assert.equal(r.profile, "strict");
  assert.equal(r.review_level, "dual");
});

test("database-migration class alone is strict dual", () => {
  const r = classify({
    filesChanged: 1,
    estimatedLines: 5,
    changeClass: "database-migration",
  });
  assert.equal(r.profile, "strict");
  assert.equal(r.review_level, "dual");
});

test("user forbidDirect forces delegated", () => {
  const r = classify({
    filesChanged: 1,
    estimatedLines: 5,
    changeClass: "documentation",
    documentationOnly: true,
    focusedValidation: true,
    forbidDirect: true,
  });
  assert.equal(r.direct_eligible, false);
});

test("profile override cannot downgrade any hard strict trigger", () => {
  const cases = [
    { changeClass: "authentication-security" },
    { changeClass: "database-migration" },
    { changeClass: "public-api" },
    { changeClass: "high-blast" },
    { credentialHandling: true },
  ];

  for (const input of cases) {
    const r = classify({
      filesChanged: 1,
      estimatedLines: 5,
      profileOverride: "fast",
      ...input,
    });
    assert.equal(r.profile, "strict", JSON.stringify(input));
    assert.equal(r.review_level, "dual", JSON.stringify(input));
    assert.equal(r.direct_eligible, false, JSON.stringify(input));
    assert.match(r.reasons.join("\n"), /cannot downgrade|Hard strict trigger/);
  }
});

test("invalid profile override is rejected", () => {
  assert.throws(
    () => classify({ profileOverride: "turbo" }),
    /Invalid profile override.*fast, balanced, or strict/,
  );
});

test("profile override can escalate but cannot lower computed risk", () => {
  const strict = classify({
    filesChanged: 10,
    estimatedLines: 400,
    changeClass: "small-feature-with-tests",
    profileOverride: "fast",
  });
  assert.equal(strict.profile, "balanced");
  assert.match(strict.reasons.join("\n"), /cannot downgrade computed balanced/);

  const escalated = classify({
    filesChanged: 1,
    estimatedLines: 10,
    changeClass: "small-feature-with-tests",
    profileOverride: "strict",
  });
  assert.equal(escalated.profile, "strict");
  assert.equal(escalated.review_level, "dual");
  assert.equal(escalated.direct_eligible, false);
});
