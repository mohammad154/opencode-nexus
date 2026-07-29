import test from "node:test";
import assert from "node:assert/strict";
import {
  validate,
  loadSchema,
  validateHandoff,
  validateRunState,
} from "../../scripts/lib/schema-validate.js";
import {
  normalizeHandoff,
  normalizeAndValidateHandoff,
  createEmptyRunState,
} from "../../scripts/lib/migrate-artifacts.js";

test("run-state schema accepts createEmptyRunState", () => {
  const state = createEmptyRunState("2026-07-30-auth");
  const r = validateRunState(state);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("run-state rejects unknown state", () => {
  const state = createEmptyRunState("x");
  state.state = "NOT_A_STATE";
  const r = validateRunState(state);
  assert.equal(r.ok, false);
});

test("implementer handoff 1.0 validates", () => {
  const data = {
    schema_version: "1.0",
    status: "DONE",
    commit: "abc",
    files_changed: ["a.js"],
    tests: [],
    verification_gates: [],
    drift_check: { plan_commit: "abc", current_head: "abc", pass: true },
    blast: { risk: "LOW", verified: true, callers_checked: [] },
  };
  const r = validateHandoff("implementer", data);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("corrupt implementer handoff rejected", () => {
  const r = validateHandoff("implementer", {
    schema_version: "1.0",
    status: "DONE_WRONG",
  });
  assert.equal(r.ok, false);
});

test("legacy 0.9 implementer migrates and validates", () => {
  const raw = {
    status: "DONE",
    commit: "deadbeef",
    files_changed: ["src/a.ts"],
    blast_verified: true,
  };
  const { ok, data, migrated_from, errors } = normalizeAndValidateHandoff(
    "implementer",
    raw,
  );
  assert.equal(migrated_from, "0.9");
  assert.equal(data.schema_version, "1.0");
  assert.equal(ok, true, JSON.stringify(errors));
  assert.ok(Array.isArray(data.verification_gates));
  assert.equal(data.blast.risk, "UNKNOWN");
  assert.equal(data.legacy_unverified, true);
});

test("reviewer missing blast gets UNKNOWN defaults", () => {
  const { data } = normalizeHandoff("spec-reviewer", {
    verdict: "APPROVED",
    task_id: "task-1",
  });
  assert.equal(data.schema_version, "1.0");
  assert.equal(data.blast.pass, null);
  assert.equal(data.blast.risk, "UNKNOWN");
  const r = validateHandoff("spec-reviewer", data);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validator type and required work", () => {
  const schema = {
    type: "object",
    required: ["a"],
    properties: { a: { type: "string", enum: ["x", "y"] } },
    additionalProperties: true,
  };
  assert.equal(validate(schema, { a: "x" }).ok, true);
  assert.equal(validate(schema, {}).ok, false);
  assert.equal(validate(schema, { a: "z" }).ok, false);
});

test("loadSchema finds run-state", () => {
  const s = loadSchema("run-state.schema.json");
  assert.equal(s.title, "NexusRunState");
});
