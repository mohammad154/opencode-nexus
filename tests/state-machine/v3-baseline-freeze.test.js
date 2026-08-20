/**
 * V4 lifecycle freeze — IMPACT_READY replaces GRAPH/BLAST; FINAL_VERIFYING added.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  STATES,
  LINEAR,
  requiredEvidence,
} from "../../scripts/lib/state-machine.js";

const V4_STATES = [
  "CREATED",
  "CLASSIFIED",
  "PLANNED",
  "IMPACT_READY",
  "IMPLEMENTING",
  "DIRECT_IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "FINAL_VERIFYING",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
];

const V4_LINEAR = [
  "CREATED",
  "CLASSIFIED",
  "PLANNED",
  "IMPACT_READY",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "FINAL_VERIFYING",
  "COMPLETED",
];

test("V4 freeze: STATES enum matches IMPACT_READY lifecycle", () => {
  assert.deepEqual([...STATES].sort(), [...V4_STATES].sort());
});

test("V4 freeze: LINEAR path is impact → implement → review → final", () => {
  assert.deepEqual(LINEAR, V4_LINEAR);
});

test("V4 freeze: PLANNED→IMPACT_READY evidence locked", () => {
  assert.deepEqual(requiredEvidence("PLANNED", "IMPACT_READY"), ["impact"]);
  assert.deepEqual(requiredEvidence("IMPACT_READY", "IMPLEMENTING"), [
    "branch",
    "impact",
    "acceptance_criteria",
    "drift",
  ]);
});

test("V4 freeze: GRAPH_READY and BLAST_READY are gone", () => {
  assert.equal(STATES.includes("GRAPH_READY"), false);
  assert.equal(STATES.includes("BLAST_READY"), false);
  assert.equal(STATES.includes("IMPACT_READY"), true);
  assert.equal(STATES.includes("FINAL_VERIFYING"), true);
});
