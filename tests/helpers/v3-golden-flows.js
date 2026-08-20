/**
 * Documented V3 golden CLI flows (from docs/workflow.md).
 * Used by freeze tests and as a migration checklist for V4.
 */
export const V3_GOLDEN_CLI = Object.freeze({
  init: ["nexus", "run", "init", "--run-id", "<id>"],
  classify: [
    "nexus",
    "classify",
    "--files",
    "<count>",
    "--lines",
    "<count>",
    "--class",
    "<change-class>",
  ],
  transitions: [
    ["transition", "--to", "CLASSIFIED"],
    ["transition", "--to", "PLANNED", "--plan-skip"],
    ["transition", "--to", "GRAPH_READY"],
    ["transition", "--to", "BLAST_READY", "--blast", "<path>"],
  ],
  validateHandoff: [
    "nexus",
    "run",
    "validate-handoff",
    "--role",
    "implementer",
    "--file",
    ".opencode/handoffs/<id>-implementer.json",
  ],
  lifecycle: [
    "CREATED",
    "CLASSIFIED",
    "PLANNED",
    "GRAPH_READY",
    "BLAST_READY",
    "IMPLEMENTING",
    "VERIFYING",
    "REVIEWING",
    "COMPLETED",
  ],
});
