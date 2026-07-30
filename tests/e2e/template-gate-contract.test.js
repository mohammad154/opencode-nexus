import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeAndValidateHandoff,
  createEmptyRunState,
} from "../../scripts/lib/migrate-artifacts.js";
import { canTransition, transition } from "../../scripts/lib/state-machine.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

/**
 * Build a handoff object from the documented implementer template field list.
 * Ensures the documented workflow produces gate-valid handoffs.
 */
function handoffFromImplementerTemplate({
  runId = "contract-run",
  unit = "unit-contract",
  base = "baseaaa",
  commit = "commitbb",
} = {}) {
  const prompt = read("skills/orchestrating/implementer-prompt.md");
  assert.match(prompt, /schema_version: "1\.1"/);
  assert.match(prompt, /verification_gates/);
  assert.match(prompt, /drift_check/);
  assert.match(prompt, /Do NOT set verification_exempt/);
  assert.equal(prompt.includes("verification_exempt"), true); // mentioned as forbidden
  assert.match(prompt, /base_commit/);

  return {
    schema_version: "1.1",
    run_id: runId,
    unit_or_task: unit,
    agent: "implementer",
    base_commit: base,
    created_at: "2026-07-30T12:00:00.000Z",
    status: "DONE",
    commit,
    files_changed: ["src/example.js"],
    tests: ["npm test"],
    tasks_completed: [unit],
    notes_for_reviewer: "from template contract",
    scope_extras: [],
    verification_gates: [{ id: "unit-tests", cmd: "npm test", pass: true }],
    drift_check: { plan_commit: base, current_head: commit, pass: true },
    blast: { risk: "LOW", verified: true, callers_checked: [] },
  };
}

function handoffFromUnifiedTemplate({
  runId = "contract-run",
  unit = "unit-contract",
  base = "baseaaa",
  commit = "commitbb",
} = {}) {
  const prompt = read("skills/orchestrating/unified-reviewer-prompt.md");
  assert.match(prompt, /"schema_version": "1\.1"/);
  assert.match(prompt, /reviewed_commit/);
  assert.match(prompt, /run_id/);

  return {
    schema_version: "1.1",
    run_id: runId,
    unit_or_task: unit,
    agent: "unified-reviewer",
    base_commit: base,
    created_at: "2026-07-30T12:00:00.000Z",
    reviewed_commit: commit,
    verdict: "APPROVED",
    change_class: "small-feature-with-tests",
    blast_risk: "LOW",
    acceptance: [],
    findings: [],
    escalate_to_dual: false,
    notes: "from template contract",
    blast: { pass: true, risk: "LOW" },
  };
}

test("documented implementer template produces a gate-valid handoff", () => {
  const handoff = handoffFromImplementerTemplate();
  const { ok, errors, data } = normalizeAndValidateHandoff(
    "implementer",
    handoff,
  );
  assert.equal(ok, true, JSON.stringify(errors));
  assert.equal(data.legacy_unverified, undefined);
  assert.equal(data.schema_version, "1.1");

  const state = {
    ...createEmptyRunState("contract-run"),
    state: "IMPLEMENTING",
    current_unit: "unit-contract",
    head_commit: "baseaaa",
    review_level: "unified",
    execution_mode: "delegated",
  };
  const verifying = canTransition(state, "VERIFYING", {
    implementer_handoff: handoff,
  });
  assert.equal(verifying.ok, true, JSON.stringify(verifying.errors));

  const applied = transition(state, "VERIFYING", {
    implementer_handoff: handoff,
  });
  assert.equal(applied.state.implementer_commit, "commitbb");
});

test("documented unified template produces a gate-valid approval", () => {
  const handoff = handoffFromUnifiedTemplate();
  const { ok, errors } = normalizeAndValidateHandoff(
    "unified-reviewer",
    handoff,
  );
  assert.equal(ok, true, JSON.stringify(errors));

  const state = {
    ...createEmptyRunState("contract-run"),
    state: "REVIEWING",
    review_level: "unified",
    current_unit: "unit-contract",
    head_commit: "baseaaa",
    implementer_commit: "commitbb",
  };
  const completed = canTransition(state, "COMPLETED", {
    unified_handoff: handoff,
  });
  assert.equal(completed.ok, true, JSON.stringify(completed.errors));
});

test("OpenCode compact router uses unprefixed skill names", () => {
  const plugin = read(".opencode/plugins/nexus.js");
  assert.match(plugin, /→ using-nexus/);
  assert.match(plugin, /→ brainstorming/);
  assert.equal(plugin.includes("nexus-using-nexus"), false);
});

test("CI runs npm test", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /run:\s*npm test/);
});
