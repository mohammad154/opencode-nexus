import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendTrajectoryStep,
  readTrajectory,
  replayTrajectory,
} from "../../scripts/lib/trajectory.js";

test("concurrent appends receive strictly increasing steps", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-traj-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "run.jsonl");

  const base = () => ({
    run_id: "concurrent",
    request: {},
    action: {},
    observation: {},
    state: { state: "IMPLEMENTING" },
  });

  // Fire many appends "concurrently"; the lockfile serializes step selection.
  await Promise.all(
    Array.from({ length: 25 }, () =>
      Promise.resolve().then(() => appendTrajectoryStep(file, base())),
    ),
  );

  const events = readTrajectory(file);
  assert.equal(events.length, 25);
  const steps = events.map((e) => e.step);
  const unique = new Set(steps);
  assert.equal(unique.size, 25, `duplicate steps: ${steps.join(",")}`);
  // Replay enforces strictly increasing steps and must not throw.
  const replay = replayTrajectory(file);
  assert.equal(replay.ok, true);
  assert.equal(replay.steps, 25);
});
