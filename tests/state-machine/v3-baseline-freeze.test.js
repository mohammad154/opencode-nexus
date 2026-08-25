/**
 * V5 lifecycle freeze — TASK_IMPACT_READY; no CLASSIFIED / DIRECT.
 * V5.1 adds FINAL_REVIEWING (whole-branch review) before FINAL_VERIFYING.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { STATES, LINEAR, requiredEvidence } from "../../scripts/lib/state-machine.js";

const EXPECTED = [
  "CREATED",
  "BRAINSTORMING",
  "WAITING_FOR_USER",
  "PLANNED",
  "TASK_IMPACT_READY",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "FINAL_REVIEWING",
  "FINAL_VERIFYING",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
];

test("V5 freeze: STATES enum matches fixed pipeline", () => {
  assert.deepEqual(STATES, EXPECTED);
});

test("V5 freeze: LINEAR happy path", () => {
  assert.deepEqual(LINEAR, [
    "CREATED",
    "BRAINSTORMING",
    "PLANNED",
    "TASK_IMPACT_READY",
    "IMPLEMENTING",
    "VERIFYING",
    "REVIEWING",
    "FINAL_REVIEWING",
    "FINAL_VERIFYING",
    "COMPLETED",
  ]);
});

test("V5 freeze: PLANNED→TASK_IMPACT_READY evidence locked", () => {
  assert.deepEqual(requiredEvidence("PLANNED", "TASK_IMPACT_READY"), ["impact"]);
  assert.deepEqual(requiredEvidence("TASK_IMPACT_READY", "IMPLEMENTING"), [
    "branch",
    "impact",
    "acceptance_criteria",
    "drift",
  ]);
  assert.deepEqual(requiredEvidence("REVIEWING", "TASK_IMPACT_READY"), [
    "review_handoff",
  ]);
  assert.deepEqual(requiredEvidence("REVIEWING", "FINAL_REVIEWING"), [
    "review_handoff",
    "review_package",
  ]);
  assert.deepEqual(requiredEvidence("FINAL_REVIEWING", "FINAL_VERIFYING"), [
    "review_handoff",
    "review_package",
  ]);
});

test("V5 freeze: retired states absent", () => {
  assert.equal(STATES.includes("CLASSIFIED"), false);
  assert.equal(STATES.includes("DIRECT_IMPLEMENTING"), false);
  assert.equal(STATES.includes("IMPACT_READY"), false);
});
