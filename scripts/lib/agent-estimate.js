import {
  normalizePlanningMode,
  planAdvisorCallCount,
} from "./planning.js";

/**
 * Canonical agent-cost model shared by the estimator and runtime budget.
 *
 * `fixLoops` counts observed/assumed fix-loop pairs. The returned
 * `budget_ceiling` reserves bounded fix-loop headroom of `max(2, units)` calls
 * and always includes the final reviewer unless an explicitly eligible
 * single-unit reuse is requested.
 */
export function agentCostModel({
  units = 1,
  tasks,
  fixLoops = 0,
  planningMode = "compact",
  advisorCalls,
  criticalDisagreement = false,
  singleUnitFinalReviewReuse = false,
} = {}) {
  const rawUnits = tasks ?? units;
  const count = Math.max(1, Math.floor(Number(rawUnits) || 1));
  const fixes = Math.max(0, Math.floor(Number(fixLoops) || 0));
  const mode = normalizePlanningMode(planningMode, "compact");
  const planAdvisor = Number.isFinite(Number(advisorCalls))
    ? Math.max(0, Math.floor(Number(advisorCalls)))
    : planAdvisorCallCount(mode, { criticalDisagreement });
  const implementer = count + fixes;
  const taskReviewer = count + fixes;
  const finalReviewer =
    singleUnitFinalReviewReuse && count === 1 ? 0 : 1;
  const total = implementer + taskReviewer + finalReviewer + planAdvisor;
  const fixHeadroom = Math.max(2, count);

  return {
    units: count,
    tasks: count,
    planning_mode: mode,
    plan_advisor_calls: planAdvisor,
    fix_loops: fixes,
    single_unit_final_review_reuse:
      Boolean(singleUnitFinalReviewReuse && count === 1),
    calls: {
      plan_advisor: planAdvisor,
      implementer,
      task_reviewer: taskReviewer,
      final_reviewer: finalReviewer,
      // Compatibility aggregate: all reviewer calls, including final.
      reviewer: taskReviewer + finalReviewer,
      total,
      fix_headroom: fixHeadroom,
      budget_ceiling: total + fixHeadroom,
    },
  };
}

/**
 * Calculate the deterministic minimum call envelope for a Nexus plan.
 * `tasks` remains a compatibility alias; the public concept is units.
 */
export function estimateAgentCalls({
  units = 1,
  tasks,
  fixLoops = 0,
  planningMode = "compact",
  advisorCalls,
  criticalDisagreement = false,
  singleUnitFinalReviewReuse = false,
} = {}) {
  const model = agentCostModel({
    units,
    tasks,
    fixLoops,
    planningMode,
    advisorCalls,
    criticalDisagreement,
    singleUnitFinalReviewReuse,
  });

  return {
    units: model.units,
    tasks: model.tasks,
    planning_mode: model.planning_mode,
    plan_advisor_calls: model.plan_advisor_calls,
    single_unit_final_review_reuse: model.single_unit_final_review_reuse,
    calls: {
      ...model.calls,
    },
    formula:
      "plan_advisor? + units*(implementer + task reviewer) + final reviewer + fix_loops*(implementer + reviewer)",
  };
}
