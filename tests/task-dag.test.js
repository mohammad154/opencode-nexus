import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskDag,
  detectCycle,
  scheduleParallel,
  readyTasks,
} from "../scripts/lib/task-dag.js";
import { globsOverlap } from "../scripts/lib/impact/boundaries.js";

test("buildTaskDag throws on duplicate task IDs", () => {
  assert.throws(
    () => buildTaskDag([{ id: "t1" }, { id: "t1" }]),
    /duplicate task id t1/i,
  );
  assert.throws(
    () => buildTaskDag([{ id: "alpha" }, { id: "beta" }, { id: "alpha" }]),
    /duplicate task id alpha/i,
  );
});

test("buildTaskDag throws on missing task id or unknown deps", () => {
  assert.throws(() => buildTaskDag([{}]), /task missing id/i);
  assert.throws(
    () => buildTaskDag([{ id: "t1", depends_on: ["nonexistent"] }]),
    /unknown dependency nonexistent for task t1/i,
  );
});

test("scheduleParallel ignores unknown task IDs in completed set", () => {
  const dag = buildTaskDag([{ id: "t1" }]);
  const plan = scheduleParallel(dag, { completed: new Set(["unknown_id", "ghost_task"]) });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.waves, [["t1"]]);
});

test("scheduleParallel handles completed as array with unknown IDs", () => {
  const dag = buildTaskDag([
    { id: "t1" },
    { id: "t2", depends_on: ["t1"] },
  ]);
  const plan = scheduleParallel(dag, { completed: ["bogus", "t1"] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.waves, [["t2"]]);
});

test("scheduleParallel correctly schedules waves with dependencies", () => {
  const dag = buildTaskDag([
    { id: "a" },
    { id: "b", depends_on: ["a"] },
    { id: "c", depends_on: ["a"] },
    { id: "d", depends_on: ["b", "c"] },
  ]);
  const plan = scheduleParallel(dag, { maxConcurrency: 2 });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.waves[0], ["a"]);
  assert.deepEqual(plan.waves[1].sort(), ["b", "c"].sort());
  assert.deepEqual(plan.waves[2], ["d"]);
});

test("globsOverlap matches identical and universal wildcards", () => {
  assert.equal(globsOverlap("src/a.js", "src/a.js"), true);
  assert.equal(globsOverlap("*", "src/a.js"), true);
  assert.equal(globsOverlap("src/a.js", "*"), true);
  assert.equal(globsOverlap("**", "src/a.js"), true);
  assert.equal(globsOverlap("src/a.js", "**"), true);
  assert.equal(globsOverlap("", "src/a.js"), false);
  assert.equal(globsOverlap(null, "src/a.js"), false);
});

test("globsOverlap handles directory prefixes", () => {
  assert.equal(globsOverlap("src/", "src/components/button.js"), true);
  assert.equal(globsOverlap("src/components/button.js", "src/"), true);
  assert.equal(globsOverlap("src/components/", "src/components/"), true);
  assert.equal(globsOverlap("src/", "lib/utils.js"), false);
});

test("globsOverlap matches overlapping wildcard patterns src/foo/*.js and src/*/*.js", () => {
  assert.equal(globsOverlap("src/foo/*.js", "src/*/*.js"), true);
  assert.equal(globsOverlap("src/*/*.js", "src/foo/*.js"), true);
});

test("globsOverlap matches recursive wildcard overlaps src/**/*.js and src/components/*.js", () => {
  assert.equal(globsOverlap("src/**/*.js", "src/components/*.js"), true);
  assert.equal(globsOverlap("src/components/*.js", "src/**/*.js"), true);
  assert.equal(globsOverlap("src/**/test/*.js", "src/client/test/foo.js"), true);
  assert.equal(globsOverlap("packages/*/src/**/*.ts", "packages/core/src/index.ts"), true);
});

test("globsOverlap matches cross wildcard segments and extensions", () => {
  assert.equal(globsOverlap("src/*/util.js", "src/auth/*.js"), true);
  assert.equal(globsOverlap("foo*.js", "*bar.js"), true);
  assert.equal(globsOverlap("*.min.js", "app.*.js"), true);
});

test("globsOverlap returns false for disjoint wildcard patterns", () => {
  assert.equal(globsOverlap("src/foo/*.js", "src/bar/*.js"), false);
  assert.equal(globsOverlap("src/*.js", "src/*.ts"), false);
  assert.equal(globsOverlap("src/components/**/*.js", "src/utils/**/*.js"), false);
  assert.equal(globsOverlap("packages/*/src/**/*.ts", "packages/*/tests/**/*.ts"), false);
  assert.equal(globsOverlap("src/foo/bar.js", "src/foo/baz.js"), false);
  assert.equal(globsOverlap("src/foo/*", "src/foo/bar/baz.js"), false);
});

test("parallel scheduler prevents parallel execution of tasks with overlapping wildcard files", () => {
  const dag = buildTaskDag([
    { id: "taskA", files: ["src/foo/*.js"] },
    { id: "taskB", files: ["src/*/*.js"] },
  ]);
  const plan = scheduleParallel(dag, { maxConcurrency: 2 });
  assert.equal(plan.ok, true);
  // Because files overlap, they cannot run in the same wave
  assert.equal(plan.waves.length, 2);
  assert.equal(plan.waves[0].length, 1);
  assert.equal(plan.waves[1].length, 1);
});

test("parallel scheduler allows parallel execution of tasks with disjoint wildcard files", () => {
  const dag = buildTaskDag([
    { id: "taskA", files: ["src/foo/*.js"] },
    { id: "taskB", files: ["src/bar/*.js"] },
  ]);
  const plan = scheduleParallel(dag, { maxConcurrency: 2 });
  assert.equal(plan.ok, true);
  assert.equal(plan.waves.length, 1);
  assert.deepEqual(plan.waves[0].sort(), ["taskA", "taskB"].sort());
});
