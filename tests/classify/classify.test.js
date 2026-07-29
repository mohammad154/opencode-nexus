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
