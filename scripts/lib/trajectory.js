import fs from "fs";
import path from "path";
import { withFileLock } from "./lock.js";

const TRAJECTORY_VERSION = "1.0";

function assertStep(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new TypeError("trajectory step must be an object");
  }
  for (const field of ["request", "action", "observation", "state"]) {
    if (!(field in step)) {
      throw new Error(`trajectory step missing ${field}`);
    }
  }
}

/**
 * Append one replayable workflow observation to a JSONL trajectory.
 * The caller owns the exact request, action, observation, state, and config
 * captured for the step so a failed run can be diagnosed without inference.
 *
 * When step is omitted, the next step number is computed under a lockfile so
 * concurrent writers cannot select the same step (replay rejects
 * non-increasing steps).
 */
export function appendTrajectoryStep(filePath, step) {
  assertStep(step);
  return withFileLock(filePath, () => {
    let stepNumber = Number.isInteger(step.step) ? step.step : null;
    if (stepNumber === null) {
      let existing = 0;
      try {
        existing = readTrajectory(filePath).length;
      } catch {
        existing = 0;
      }
      stepNumber = existing + 1;
    }
    const entry = {
      schema_version: TRAJECTORY_VERSION,
      step: stepNumber,
      recorded_at: step.recorded_at || new Date().toISOString(),
      request: step.request,
      action: step.action,
      observation: step.observation,
      state: step.state,
      configuration: step.configuration || {},
    };
    if (step.run_id != null) entry.run_id = step.run_id;

    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  });
}

export function readTrajectory(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  return lines.map((line, index) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid trajectory JSON at line ${index + 1}: ${error.message}`);
    }
    assertStep(entry);
    if (entry.schema_version !== TRAJECTORY_VERSION) {
      throw new Error(
        `unsupported trajectory schema ${entry.schema_version || "missing"}`,
      );
    }
    return entry;
  });
}

/**
 * Replay a trajectory by validating its ordered observations and returning
 * the last persisted state. This is intentionally side-effect free: callers
 * can inspect the returned events or attach an onStep observer.
 */
export function replayTrajectory(filePath, { onStep } = {}) {
  const events = readTrajectory(filePath);
  let previousStep = -1;
  let state = null;
  let failed = false;

  for (const event of events) {
    if (event.step != null) {
      if (!Number.isInteger(event.step) || event.step <= previousStep) {
        throw new Error("trajectory steps must be increasing integers");
      }
      previousStep = event.step;
    }
    state = event.state;
    const stateName =
      typeof state === "string" ? state : state && state.state;
    failed ||= stateName === "FAILED";
    if (typeof onStep === "function") onStep(event, state);
  }

  return {
    ok: true,
    run_id: events.find((event) => event.run_id)?.run_id || null,
    steps: events.length,
    failed,
    state,
    events,
  };
}
