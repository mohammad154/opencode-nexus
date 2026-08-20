import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "../scripts/lib/lock.js";
import {
  createEmptyRunState,
  writeRunState,
  readRunState,
} from "../scripts/lib/migrate-artifacts.js";
import {
  appendTrajectoryStep,
  readTrajectory,
} from "../scripts/lib/trajectory.js";

test("two simultaneous writeRunState with same revision: one succeeds, one throws REVISION_CONFLICT", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lock-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const initial = writeRunState(dir, createEmptyRunState("race-1"));
  assert.strictEqual(initial._revision, 1);

  // Both writers attempt to advance from revision 1
  let writer1Ok = false;
  let writer2Conflict = false;

  try {
    writeRunState(dir, { ...initial, current_unit: "unit-1" });
    writer1Ok = true;
  } catch {}

  try {
    writeRunState(dir, { ...initial, current_unit: "unit-2" });
  } catch (err) {
    if (err.code === "REVISION_CONFLICT") writer2Conflict = true;
  }

  assert.strictEqual(writer1Ok, true);
  assert.strictEqual(writer2Conflict, true);
});

test("concurrent writeRunState with same base revision results in exactly 1 winner and N-1 REVISION_CONFLICTs", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lock-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const initial = writeRunState(dir, createEmptyRunState("race-n"));
  assert.strictEqual(initial._revision, 1);

  const concurrency = 20;
  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, idx) =>
      Promise.resolve().then(() => {
        try {
          const written = writeRunState(dir, {
            ...initial,
            current_unit: `unit-${idx}`,
          });
          return { ok: true, state: written };
        } catch (err) {
          return { ok: false, code: err.code, message: err.message };
        }
      }),
    ),
  );

  const winners = results.filter((r) => r.ok);
  const conflicts = results.filter((r) => !r.ok && r.code === "REVISION_CONFLICT");

  assert.strictEqual(winners.length, 1, "exactly one writer must succeed");
  assert.strictEqual(
    conflicts.length,
    concurrency - 1,
    "all other writers must get REVISION_CONFLICT",
  );

  const finalState = readRunState(dir, "race-n");
  assert.strictEqual(finalState._revision, 2);
});

test("withFileLock executes callback and cleans up lockfile", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lock-unit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const targetFile = path.join(dir, "data.txt");
  const lockFile = `${targetFile}.lock`;

  let executed = false;
  const result = withFileLock(targetFile, () => {
    assert.strictEqual(fs.existsSync(lockFile), true, "lockfile must exist during execution");
    executed = true;
    return "lock-result";
  });

  assert.strictEqual(executed, true);
  assert.strictEqual(result, "lock-result");
  assert.strictEqual(fs.existsSync(lockFile), false, "lockfile must be removed after execution");
});

test("withFileLock cleans up lockfile when callback throws", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lock-err-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const targetFile = path.join(dir, "data.txt");
  const lockFile = `${targetFile}.lock`;

  assert.throws(
    () => {
      withFileLock(targetFile, () => {
        assert.strictEqual(fs.existsSync(lockFile), true);
        throw new Error("inner error");
      });
    },
    (err) => err.message === "inner error",
  );

  assert.strictEqual(fs.existsSync(lockFile), false, "lockfile must be cleaned up on throw");
});

test("withFileLock reaps stale lockfile older than staleMs", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lock-stale-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const targetFile = path.join(dir, "data.txt");
  const lockFile = `${targetFile}.lock`;

  // Create an old stale lockfile
  fs.writeFileSync(lockFile, "stale-pid", "utf8");
  const oldTime = (Date.now() - 20000) / 1000;
  fs.utimesSync(lockFile, oldTime, oldTime);

  let executed = false;
  const result = withFileLock(
    targetFile,
    () => {
      executed = true;
      return "reaped";
    },
    { staleMs: 5000 },
  );

  assert.strictEqual(executed, true);
  assert.strictEqual(result, "reaped");
  assert.strictEqual(fs.existsSync(lockFile), false);
});

test("withFileLock throws when lock cannot be acquired within retries", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lock-unacq-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const targetFile = path.join(dir, "data.txt");
  const lockFile = `${targetFile}.lock`;

  // Create an active (fresh) lockfile
  fs.writeFileSync(lockFile, "active", "utf8");

  assert.throws(
    () => {
      withFileLock(targetFile, () => {}, {
        retries: 3,
        delayMs: 2,
        staleMs: 60000,
      });
    },
    (err) => err.message.includes("could not acquire lock"),
  );
});

test("trajectory appendTrajectoryStep integrates with withFileLock", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-traj-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, "traj.jsonl");
  const step = {
    run_id: "traj-test",
    request: { req: 1 },
    action: { act: 1 },
    observation: { obs: 1 },
    state: { state: "IMPLEMENTING" },
  };

  const entry = appendTrajectoryStep(file, step);
  assert.strictEqual(entry.step, 1);
  const items = readTrajectory(file);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].step, 1);
});
