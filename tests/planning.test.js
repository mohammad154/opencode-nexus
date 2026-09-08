import test from "node:test";
import assert from "node:assert/strict";
import {
  inferPlanningMode,
  modelFamily,
  planAdvisorCallCount,
  validatePlanAdvisorModelDiversity,
} from "../scripts/lib/planning.js";
import { estimateAgentCalls } from "../scripts/lib/agent-estimate.js";
import { getAgentCallBudget } from "../scripts/lib/providers.js";

test("planning mode inference is conservative and deterministic", () => {
  assert.equal(inferPlanningMode({ files_changed: 1, estimated_lines: 10 }), "compact");
  assert.equal(inferPlanningMode({ files_changed: 3, estimated_lines: 120 }), "standard");
  assert.equal(inferPlanningMode({ change_class: "database-migration" }), "deep");
  assert.equal(inferPlanningMode({ planning_mode: "deep", files_changed: 1 }), "deep");
});

test("plan-advisor call envelope is conditional", () => {
  assert.equal(planAdvisorCallCount("compact"), 0);
  assert.equal(planAdvisorCallCount("standard"), 1);
  assert.equal(planAdvisorCallCount("deep"), 1);
  assert.equal(
    planAdvisorCallCount("deep", { criticalDisagreement: true }),
    2,
  );
  assert.equal(planAdvisorCallCount("standard", { criticalDisagreement: true }), 1);
});

test("plan advisor diversity rejects an explicit model collision", () => {
  assert.equal(
    validatePlanAdvisorModelDiversity({
      orchestratorModel: "openai/gpt-5",
      planAdvisorModel: "openai/gpt-5",
    }).ok,
    false,
  );
  assert.equal(
    validatePlanAdvisorModelDiversity({
      orchestratorModel: "opencode-go/minimax-m3",
      planAdvisorModel: "openai/gpt-5-mini",
    }).different_family,
    true,
  );
  assert.equal(modelFamily("openai/gpt-5-mini"), "gpt");
  assert.equal(modelFamily("anthropic/claude-sonnet-4"), "claude");
  const sameFamily = validatePlanAdvisorModelDiversity({
    orchestratorModel: "openai/gpt-5",
    planAdvisorModel: "azure/gpt-5-mini",
  });
  assert.equal(sameFamily.different_family, false);
  assert.equal(sameFamily.different_provider_namespace, true);
});

test("agent estimate counts units and planning calls without changing compact V5", () => {
  const compact = estimateAgentCalls({ units: 3 });
  assert.equal(compact.calls.total, 7);
  assert.equal(compact.plan_advisor_calls, 0);
  assert.equal(compact.calls.budget_ceiling, getAgentCallBudget({ units: 3 }).max_calls);

  const standard = estimateAgentCalls({ units: 3, planningMode: "standard" });
  assert.equal(standard.calls.total, 8);
  assert.equal(standard.calls.plan_advisor, 1);
  assert.equal(
    standard.calls.budget_ceiling,
    getAgentCallBudget({ units: 3, planningAdvisorCalls: 1 }).max_calls,
  );
  assert.equal(
    standard.calls.budget_ceiling,
    getAgentCallBudget({ units: 3, planningMode: "standard" }).max_calls,
  );

  const reused = estimateAgentCalls({
    units: 1,
    planningMode: "compact",
    singleUnitFinalReviewReuse: true,
  });
  assert.equal(reused.calls.final_reviewer, 0);
  assert.equal(reused.calls.total, 2);
});
