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
  HANDOFF_VERSION,
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

test("implementer handoff 1.1 validates", () => {
  const data = {
    schema_version: "1.1",
    run_id: "run-a",
    unit_or_task: "unit-1",
    agent: "implementer",
    base_commit: "abc",
    created_at: "2026-07-30T00:00:00.000Z",
    status: "DONE",
    commit: "def",
    files_changed: ["a.js"],
    tests: [],
    verification_gates: [{ id: "unit", cmd: "npm test", pass: true }],
    drift_check: { plan_commit: "abc", current_head: "def", pass: true },
    blast: { risk: "LOW", verified: true, callers_checked: [] },
  };
  const r = validateHandoff("implementer", data);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("implementer schema rejects verification_exempt field as authorization", () => {
  const schema = loadSchema("handoff-implementer.schema.json");
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      schema.properties || {},
      "verification_exempt",
    ),
    false,
  );
});

test("corrupt implementer handoff rejected", () => {
  const r = validateHandoff("implementer", {
    schema_version: "1.1",
    status: "DONE_WRONG",
  });
  assert.equal(r.ok, false);
});

test("legacy 0.9 implementer migrates to 1.1 as legacy_unverified", () => {
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
  assert.equal(data.schema_version, HANDOFF_VERSION);
  assert.equal(ok, true, JSON.stringify(errors));
  assert.ok(Array.isArray(data.verification_gates));
  assert.equal(data.blast.risk, "UNKNOWN");
  assert.equal(data.legacy_unverified, true);
  assert.equal(data.drift_check.pass, null);
});

test("legacy 1.0 implementer migrates as legacy_unverified without inventing pass", () => {
  const raw = {
    schema_version: "1.0",
    status: "DONE",
    commit: "abc",
  };
  const { data, ok } = normalizeAndValidateHandoff("implementer", raw);
  assert.equal(ok, true);
  assert.equal(data.schema_version, "1.1");
  assert.equal(data.legacy_unverified, true);
  assert.equal("verification_exempt" in data, false);
});

test("normalize strips verification_exempt from implementer handoffs", () => {
  const { data } = normalizeHandoff("implementer", {
    schema_version: "1.1",
    run_id: "r",
    unit_or_task: "u",
    agent: "implementer",
    base_commit: "a",
    created_at: "2026-07-30T00:00:00.000Z",
    status: "DONE",
    commit: "b",
    verification_exempt: true,
    verification_gates: [],
    drift_check: { pass: null },
  });
  assert.equal("verification_exempt" in data, false);
});

test("reviewer missing impact gets UNKNOWN defaults and upgrades to 1.2", () => {
  const { data } = normalizeHandoff("reviewer", {
    schema_version: "1.1",
    run_id: "r",
    unit_or_task: "task-1",
    agent: "reviewer",
    base_commit: "a",
    created_at: "2026-07-30T00:00:00.000Z",
    verdict: "APPROVED",
    reviewed_commit: "b",
    task_id: "task-1",
  });
  assert.equal(data.schema_version, "1.2");
  assert.equal(data.agent, "reviewer");
  assert.equal(data.impact.pass, null);
  assert.equal(data.impact.risk, "UNKNOWN");
  assert.ok(Array.isArray(data.files_reviewed));
  assert.ok(Array.isArray(data.checks));
  const r = validateHandoff("reviewer", data);
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
