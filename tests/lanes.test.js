/**
 * PR9 lane eligibility and join guards (pure).
 *
 * These tests fix the behaviour that makes parallel execution safe to allow at
 * all: a unit enters a wave only when its dependencies, identity, and file scope
 * are all known and provably independent, and a join is refused whenever the
 * work that came back cannot be proven to be the work that was authorized.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LANE_CONCURRENCY,
  LANE_EXCLUSION,
  LANE_STATUS,
  MAX_LANE_CONCURRENCY,
  completedUnits,
  findLane,
  formatLaneEligibility,
  laneBranch,
  laneEligibility,
  laneHandoffBindingErrors,
  laneId,
  laneJoinErrors,
  openLanes,
  rebindLaneHandoff,
} from "../scripts/lib/lanes.js";

function unit(id, files, extra = {}) {
  return {
    id,
    allowed_files: files,
    acceptance_criteria: [`${id} works`],
    depends_on: [],
    ...extra,
  };
}

function planState(units, extra = {}) {
  return {
    run_id: "lane-run",
    state: "TASK_IMPACT_READY",
    execution_units: units,
    task_history: [],
    ...extra,
  };
}

function approved(unitId) {
  return {
    id: unitId,
    verdict: "APPROVED",
    reviewed_commit: "c".repeat(40),
    acceptance_criteria: [`${unitId} works`],
    review_handoff: {
      verdict: "APPROVED",
      review_scope: "task",
      acceptance: [{ id: `${unitId}/AC1`, status: "PASS", evidence: [{ file: "x", line: 1, reason: "ok" }] }],
    },
  };
}

test("independent units with disjoint scope form a wave", () => {
  const state = planState([unit("unit-1", ["src/a.js"]), unit("unit-2", ["src/b.js"])]);
  const result = laneEligibility(state, { maxConcurrency: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.parallel, true);
  assert.deepEqual(
    result.wave.map((entry) => entry.id),
    ["unit-1", "unit-2"],
  );
  // Lane identity must be usable as both a path and a git ref.
  assert.equal(result.wave[0].lane, laneId("unit-1"));
  assert.equal(result.wave[0].branch, laneBranch("lane-run", "unit-1"));
  assert.match(result.wave[0].branch, /^nexus\/lane-run\/lane-unit-1$/);
});

test("units that could touch the same file are never co-scheduled", () => {
  const state = planState([
    unit("unit-1", ["src/shared.js", "src/a.js"]),
    unit("unit-2", ["src/shared.js"]),
  ]);
  const result = laneEligibility(state, { maxConcurrency: 2 });
  assert.deepEqual(
    result.wave.map((entry) => entry.id),
    ["unit-1"],
  );
  const excluded = result.excluded.find((entry) => entry.id === "unit-2");
  assert.equal(excluded.reason, LANE_EXCLUSION.FILE_CONFLICT);
  assert.equal(excluded.detail, "unit-1");
  // One unit is not parallelism; the caller must run it the ordinary way.
  assert.equal(result.parallel, false);
});

test("overlapping globs count as sharing files", () => {
  const state = planState([unit("unit-1", ["src/**"]), unit("unit-2", ["src/deep/b.js"])]);
  const result = laneEligibility(state, { maxConcurrency: 2 });
  assert.deepEqual(
    result.wave.map((entry) => entry.id),
    ["unit-1"],
  );
  assert.equal(
    result.excluded.find((entry) => entry.id === "unit-2").reason,
    LANE_EXCLUSION.FILE_CONFLICT,
  );
});

test("a unit with no declared scope never runs in a lane", () => {
  // Scope lock already fails closed on an unknown allowlist; an unprovable
  // scope must not be parallelized either.
  const state = planState([unit("unit-1", []), unit("unit-2", ["src/b.js"])]);
  const result = laneEligibility(state, { maxConcurrency: 2 });
  assert.deepEqual(
    result.wave.map((entry) => entry.id),
    ["unit-2"],
  );
  assert.equal(
    result.excluded.find((entry) => entry.id === "unit-1").reason,
    LANE_EXCLUSION.UNKNOWN_SCOPE,
  );
});

test("a unit waits for its dependencies to be reviewed, not merely merged", () => {
  const state = planState([
    unit("unit-1", ["src/a.js"]),
    unit("unit-2", ["src/b.js"], { depends_on: ["unit-1"] }),
  ]);
  const before = laneEligibility(state, { maxConcurrency: 2 });
  assert.deepEqual(
    before.wave.map((entry) => entry.id),
    ["unit-1"],
  );
  const excluded = before.excluded.find((entry) => entry.id === "unit-2");
  assert.equal(excluded.reason, LANE_EXCLUSION.DEPENDENCY_PENDING);
  assert.equal(excluded.detail, "unit-1");

  const after = laneEligibility(
    planState(state.execution_units, { task_history: [approved("unit-1")] }),
    { maxConcurrency: 2 },
  );
  assert.deepEqual(
    after.wave.map((entry) => entry.id),
    ["unit-2"],
  );
  assert.equal(
    after.excluded.find((entry) => entry.id === "unit-1").reason,
    LANE_EXCLUSION.ALREADY_COVERED,
  );
});

test("the unit the parent is working on holds its scope", () => {
  const state = planState(
    [unit("unit-1", ["src/a.js"]), unit("unit-2", ["src/a.js", "src/b.js"]), unit("unit-3", ["src/c.js"])],
    { current_unit: "unit-1" },
  );
  const result = laneEligibility(state, { maxConcurrency: 3 });
  assert.deepEqual(
    result.wave.map((entry) => entry.id),
    ["unit-3"],
  );
  assert.equal(result.excluded.find((e) => e.id === "unit-1").reason, LANE_EXCLUSION.IN_FLIGHT);
  // unit-2 overlaps the in-flight unit's files even though it is not itself running.
  assert.equal(result.excluded.find((e) => e.id === "unit-2").reason, LANE_EXCLUSION.FILE_CONFLICT);
});

test("already open lanes hold their scope too", () => {
  const state = planState([unit("unit-1", ["src/a.js"]), unit("unit-2", ["src/a.js"])]);
  const result = laneEligibility(state, {
    maxConcurrency: 2,
    activeLanes: [{ unit: "unit-1", status: LANE_STATUS.RUNNING }],
  });
  assert.deepEqual(result.wave, []);
  assert.equal(result.excluded.find((e) => e.id === "unit-2").reason, LANE_EXCLUSION.FILE_CONFLICT);
});

test("open lanes consume the configured concurrency capacity", () => {
  const units = [1, 2, 3, 4].map((n) => unit(`unit-${n}`, [`src/${n}.js`]));
  const oneOpen = laneEligibility(planState(units), {
    maxConcurrency: 2,
    activeLanes: [{ unit: "unit-1", status: LANE_STATUS.RUNNING }],
  });
  assert.deepEqual(oneOpen.wave.map((entry) => entry.id), ["unit-2"]);
  assert.equal(oneOpen.max_concurrency, 2);
  assert.equal(
    oneOpen.excluded.find((entry) => entry.id === "unit-1").reason,
    LANE_EXCLUSION.IN_FLIGHT,
  );
  assert.equal(
    oneOpen.excluded.find((entry) => entry.id === "unit-3").reason,
    LANE_EXCLUSION.CONCURRENCY_LIMIT,
  );

  const capacityFull = laneEligibility(planState(units), {
    maxConcurrency: 2,
    activeLanes: [
      { unit: "unit-1", status: LANE_STATUS.RUNNING },
      { unit: "unit-2", status: LANE_STATUS.IMPLEMENTED },
    ],
  });
  assert.deepEqual(capacityFull.wave, []);
});

test("concurrency is bounded and the excess is reported, not silently dropped", () => {
  const units = [1, 2, 3, 4, 5].map((n) => unit(`unit-${n}`, [`src/${n}.js`]));
  const two = laneEligibility(planState(units), { maxConcurrency: 2 });
  assert.equal(two.wave.length, 2);
  assert.equal(
    two.excluded.filter((entry) => entry.reason === LANE_EXCLUSION.CONCURRENCY_LIMIT).length,
    3,
  );

  const tooWide = laneEligibility(planState(units), { maxConcurrency: MAX_LANE_CONCURRENCY + 1 });
  assert.equal(tooWide.ok, false);
  assert.match(tooWide.errors.join(" "), /exceeds the ceiling/);
  const bad = laneEligibility(planState(units), { maxConcurrency: 0 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /positive integer/);
  assert.equal(
    laneEligibility(planState(units)).wave.length,
    DEFAULT_LANE_CONCURRENCY,
  );
});

test("a plan without persisted units schedules nothing", () => {
  const result = laneEligibility({ run_id: "r", state: "PLANNED" }, { maxConcurrency: 2 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.wave, []);
  assert.match(result.errors.join(" "), /no planned execution units/);
});

test("a dependency cycle refuses to schedule instead of guessing an order", () => {
  const state = planState([
    unit("unit-1", ["src/a.js"], { depends_on: ["unit-2"] }),
    unit("unit-2", ["src/b.js"], { depends_on: ["unit-1"] }),
  ]);
  const result = laneEligibility(state, { maxConcurrency: 2 });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /dependency cycle/);
});

test("completedUnits reads the PR8 ledger", () => {
  const state = planState([unit("unit-1", ["src/a.js"])], { task_history: [approved("unit-1")] });
  assert.deepEqual([...completedUnits(state)], ["unit-1"]);
});

test("a rebase conflict refuses the join and names the failed guard", () => {
  const errors = laneJoinErrors({
    unit: "unit-2",
    allowedFiles: ["src/b.js"],
    diffFiles: [],
    conflicted: true,
    parentBase: "a".repeat(40),
    joinedCommit: null,
    ancestor: null,
    laneHandoff: { status: "DONE", agent: "implementer", unit_or_task: "unit-2" },
  });
  assert.match(errors.join(" | "), /file-disjointness guard did not hold/);
  // A conflict is never resolved automatically: that would be unreviewed code.
  assert.match(errors.join(" | "), /abort the lane and implement it sequentially/);
});

test("a join is refused when the rebased work leaves the unit's scope", () => {
  const errors = laneJoinErrors({
    unit: "unit-2",
    allowedFiles: ["src/b.js", "tests/b.test.js"],
    diffFiles: ["src/b.js", "src/secret.js"],
    conflicted: false,
    parentBase: "a".repeat(40),
    joinedCommit: "b".repeat(40),
    ancestor: true,
    laneHandoff: { status: "DONE", agent: "implementer", unit_or_task: "unit-2" },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /changed files outside its scope: src\/secret\.js/);
});

test("scope matching accepts directories and globs the plan actually uses", () => {
  const ok = laneJoinErrors({
    unit: "unit-2",
    allowedFiles: ["src/feature/", "tests/**", "docs/one.md"],
    diffFiles: ["src/feature/deep/a.js", "tests/x/y.test.js", "docs/one.md"],
    conflicted: false,
    parentBase: "a".repeat(40),
    joinedCommit: "b".repeat(40),
    ancestor: true,
    laneHandoff: { status: "DONE", agent: "implementer", unit_or_task: "unit-2" },
  });
  assert.deepEqual(ok, []);
});

test("a join is refused without a DONE implementer handoff for the right unit", () => {
  const base = {
    unit: "unit-2",
    allowedFiles: ["src/b.js"],
    diffFiles: ["src/b.js"],
    conflicted: false,
    parentBase: "a".repeat(40),
    joinedCommit: "b".repeat(40),
    ancestor: true,
  };
  assert.match(laneJoinErrors({ ...base, laneHandoff: null }).join(" | "), /no implementer handoff/);
  assert.match(
    laneJoinErrors({ ...base, laneHandoff: { status: "BLOCKED", agent: "implementer" } }).join(" | "),
    /status must be DONE\*/,
  );
  assert.match(
    laneJoinErrors({
      ...base,
      laneHandoff: { status: "DONE", agent: "implementer", unit_or_task: "unit-9" },
    }).join(" | "),
    /reports a different unit \(unit-9\)/,
  );
  assert.match(
    laneJoinErrors({
      ...base,
      laneHandoff: { status: "DONE", agent: "reviewer", unit_or_task: "unit-2" },
    }).join(" | "),
    /agent must be implementer/,
  );
});

test("a join is refused when ancestry or the commit itself is missing", () => {
  const handoff = { status: "DONE", agent: "implementer", unit_or_task: "unit-2" };
  assert.match(
    laneJoinErrors({
      unit: "unit-2",
      allowedFiles: ["src/b.js"],
      diffFiles: ["src/b.js"],
      conflicted: false,
      parentBase: "a".repeat(40),
      joinedCommit: null,
      laneHandoff: handoff,
    }).join(" | "),
    /produced no commit to join/,
  );
  assert.match(
    laneJoinErrors({
      unit: "unit-2",
      allowedFiles: ["src/b.js"],
      diffFiles: ["src/b.js"],
      conflicted: false,
      parentBase: "a".repeat(40),
      joinedCommit: "b".repeat(40),
      ancestor: false,
      laneHandoff: handoff,
    }).join(" | "),
    /is not a descendant of the parent tip/,
  );
});

test("an empty lane has nothing to join", () => {
  const errors = laneJoinErrors({
    unit: "unit-2",
    allowedFiles: ["src/b.js"],
    diffFiles: [],
    conflicted: false,
    parentBase: "a".repeat(40),
    joinedCommit: "b".repeat(40),
    ancestor: true,
    laneHandoff: { status: "DONE", agent: "implementer", unit_or_task: "unit-2" },
  });
  assert.match(errors.join(" | "), /changes nothing/);
});

test("a unit with no persisted scope cannot be joined", () => {
  const errors = laneJoinErrors({
    unit: "unit-2",
    allowedFiles: [],
    diffFiles: ["src/b.js"],
    conflicted: false,
    parentBase: "a".repeat(40),
    joinedCommit: "b".repeat(40),
    ancestor: true,
    laneHandoff: { status: "DONE", agent: "implementer", unit_or_task: "unit-2" },
  });
  assert.match(errors.join(" | "), /no persisted allowed_files/);
});

test("a lane handoff must match the run, unit, lane base, and pre-rebase tip", () => {
  const binding = {
    runId: "lane-run",
    unit: "unit-2",
    laneBaseCommit: "a".repeat(40),
    laneTip: "b".repeat(40),
    laneHandoff: {
      run_id: "lane-run",
      unit_or_task: "unit-2",
      agent: "implementer",
      status: "DONE",
      base_commit: "a".repeat(40),
      commit: "b".repeat(40),
    },
  };
  assert.deepEqual(laneHandoffBindingErrors(binding), []);

  const mismatches = [
    [{ run_id: "other-run" }, /run_id/],
    [{ unit_or_task: "unit-1" }, /unit/],
    [{ base_commit: "c".repeat(40) }, /base_commit/],
    [{ commit: "c".repeat(40) }, /initial tip/],
  ];
  for (const [change, expected] of mismatches) {
    const errors = laneHandoffBindingErrors({
      ...binding,
      laneHandoff: { ...binding.laneHandoff, ...change },
    });
    assert.match(errors.join(" | "), expected);
  }
});

test("rebinding rewrites only the commits the join created and keeps provenance", () => {
  const laneHandoff = {
    schema_version: "1.1",
    run_id: "lane-run",
    unit_or_task: "unit-2",
    agent: "implementer",
    status: "DONE",
    base_commit: "1".repeat(40),
    commit: "2".repeat(40),
    created_at: "2020-01-01T00:00:00.000Z",
    files_changed: ["src/b.js"],
    notes: "clamped avg",
  };
  const rebound = rebindLaneHandoff(laneHandoff, {
    runId: "lane-run",
    base: "3".repeat(40),
    commit: "4".repeat(40),
    lane: "lane-unit-2",
    branch: "nexus/lane-run/lane-unit-2",
    now: "2026-01-01T00:00:00.000Z",
  });
  // The parent's unchanged bindings are what these fields must satisfy.
  assert.equal(rebound.base_commit, "3".repeat(40));
  assert.equal(rebound.commit, "4".repeat(40));
  assert.equal(rebound.created_at, "2026-01-01T00:00:00.000Z");
  // Everything the agent reported about its work is carried through untouched.
  assert.equal(rebound.notes, "clamped avg");
  assert.deepEqual(rebound.files_changed, ["src/b.js"]);
  assert.equal(rebound.status, "DONE");
  // The rewrite is auditable.
  assert.equal(rebound.lane_provenance.lane_commit, "2".repeat(40));
  assert.equal(rebound.lane_provenance.lane_base_commit, "1".repeat(40));
  assert.equal(rebound.lane_provenance.lane_created_at, "2020-01-01T00:00:00.000Z");
  assert.equal(rebound.lane_provenance.rebased_onto, "3".repeat(40));
});

test("lane records are filtered and found by unit", () => {
  const laneFile = {
    lanes: [
      { unit: "unit-1", status: LANE_STATUS.JOINED },
      { unit: "unit-2", status: LANE_STATUS.RUNNING },
      { unit: "unit-3", status: LANE_STATUS.ABANDONED },
      { status: LANE_STATUS.RUNNING },
    ],
  };
  assert.deepEqual(
    openLanes(laneFile).map((lane) => lane.unit),
    ["unit-2"],
  );
  assert.equal(findLane(laneFile, "unit-3").status, LANE_STATUS.ABANDONED);
  assert.equal(findLane(laneFile, "nope"), null);
});

test("an unsafe unit id cannot become a lane path or branch", () => {
  assert.equal(laneId("../escape"), null);
  assert.equal(laneBranch("run", "../escape"), null);
  assert.equal(laneBranch("../run", "unit-1"), null);
});

test("formatLaneEligibility reports the wave and every exclusion", () => {
  const state = planState([
    unit("unit-1", ["src/a.js"]),
    unit("unit-2", ["src/a.js"]),
    unit("unit-3", []),
  ]);
  const text = formatLaneEligibility(laneEligibility(state, { maxConcurrency: 2 }));
  assert.match(text, /lane wave \(max concurrency 2\)/);
  assert.match(text, /unit-1 — src\/a\.js/);
  assert.match(text, /unit-2 — FILE_CONFLICT \(unit-1\)/);
  assert.match(text, /unit-3 — UNKNOWN_SCOPE/);
  assert.match(text, /parallel: no/);
});
