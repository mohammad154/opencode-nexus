/**
 * @deprecated V5 fixed pipeline — retained only for historical reference.
 * Do not use in new tests. Prefer tests/helpers/gate-fixtures.js + V5 states.
 */
export const V3_GOLDEN_DEPRECATED = true;

export const V5_HAPPY_PATH = [
  ["init", "--run-id", "demo"],
  ["transition", "--to", "BRAINSTORMING"],
  ["transition", "--to", "PLANNED"], // requires .opencode/plans/PLAN.md
  ["transition", "--to", "TASK_IMPACT_READY"],
  ["transition", "--to", "IMPLEMENTING"],
  ["transition", "--to", "VERIFYING"],
  ["transition", "--to", "REVIEWING"],
  ["transition", "--to", "FINAL_REVIEWING"],
  ["transition", "--to", "FINAL_VERIFYING"],
  ["transition", "--to", "COMPLETED"],
];

export const V5_STATES = [
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
];
