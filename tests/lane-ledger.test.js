/**
 * Lane ledger publication: concurrent starts must not drop each other's records,
 * and a corrupt or symlinked ledger must not look like an empty one.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import {
  laneFilePath,
  planLanes,
  readLaneFile,
  startLane,
} from "../scripts/lib/lane-runtime.js";

const laneRuntimeUrl = pathToFileURL(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../scripts/lib/lane-runtime.js",
  ),
).href;
const roots = [];

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function keep(dir) {
  roots.push(dir);
  return dir;
}

function gitRepo() {
  const root = keep(
    fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lane-ledger-")),
  );
  spawnSync("git", ["init", "--quiet", root]);
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "lane\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-m", "init", "--quiet"], { cwd: root });
  return root;
}

function laneState() {
  return {
    run_id: "lane-run",
    state: "TASK_IMPACT_READY",
    execution_units: [
      {
        id: "unit-1",
        allowed_files: ["src/a.js"],
        acceptance_criteria: ["a works"],
        depends_on: [],
      },
      {
        id: "unit-2",
        allowed_files: ["src/b.js"],
        acceptance_criteria: ["b works"],
        depends_on: [],
      },
    ],
    task_history: [],
  };
}

function startInChild(root, unitId, maxConcurrency) {
  const runner = path.join(root, `start-${unitId}.mjs`);
  fs.writeFileSync(
    runner,
    `import { startLane } from ${JSON.stringify(laneRuntimeUrl)};
const result = startLane(process.env.LANE_ROOT, JSON.parse(process.env.LANE_STATE), process.env.LANE_UNIT, {
  maxConcurrency: Number(process.env.LANE_MAX),
});
process.stdout.write(JSON.stringify({
  ok: result.ok,
  code: result.code || null,
  unit: result.lane?.unit || null,
  path: result.lane?.path || null,
}));
`,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner], {
      env: {
        ...process.env,
        LANE_ROOT: root,
        LANE_STATE: JSON.stringify(laneState()),
        LANE_UNIT: unitId,
        LANE_MAX: String(maxConcurrency),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

test("a missing lane ledger is empty", () => {
  const root = keep(
    fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lane-missing-")),
  );
  const ledger = readLaneFile(root, "lane-run");
  assert.deepEqual(ledger.lanes, []);
});

test("a corrupt lane ledger is not treated as empty and is not overwritten", () => {
  const root = gitRepo();
  const file = laneFilePath(root, "lane-run");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = '{"lanes":[{"unit":"unit-1"';
  fs.writeFileSync(file, partial);
  assert.throws(() => readLaneFile(root, "lane-run"), /corrupt or partial/);
  const plan = planLanes(root, laneState(), { maxConcurrency: 1 });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "LANE_LEDGER_CORRUPT");
  assert.deepEqual(plan.wave, []);
  const started = startLane(root, laneState(), "unit-1", { maxConcurrency: 1 });
  assert.equal(started.ok, false);
  assert.equal(started.code, "LANE_LEDGER_CORRUPT");
  assert.equal(fs.readFileSync(file, "utf8"), partial);
});

test("a symlinked lane ledger is refused and not written through", () => {
  const root = gitRepo();
  const outside = keep(
    fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lane-symlink-outside-")),
  );
  const outsideFile = path.join(outside, "ledger.json");
  const original = `${JSON.stringify({ secret: true })}\n`;
  fs.writeFileSync(outsideFile, original);
  const file = laneFilePath(root, "lane-run");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(outsideFile, file);
  assert.throws(
    () => readLaneFile(root, "lane-run"),
    /filesystem boundary|symlink/,
  );
  const started = startLane(root, laneState(), "unit-1", { maxConcurrency: 1 });
  assert.equal(started.ok, false);
  assert.equal(started.code, "LANE_LEDGER_BOUNDARY");
  assert.equal(fs.readFileSync(outsideFile, "utf8"), original);
});

test("parallel lane starts keep every reserved lane and honor a limit of one", async () => {
  const limited = gitRepo();
  const [firstLimited, secondLimited] = await Promise.all([
    startInChild(limited, "unit-1", 1),
    startInChild(limited, "unit-2", 1),
  ]);
  for (const result of [firstLimited, secondLimited]) {
    assert.equal(result.status, 0, result.stderr);
  }
  const limitedResults = [firstLimited, secondLimited].map((result) =>
    JSON.parse(result.stdout),
  );
  assert.equal(limitedResults.filter((result) => result.ok).length, 1);
  const limitedLedger = readLaneFile(limited, "lane-run");
  assert.equal(limitedLedger.lanes.length, 1);
  assert.equal(limitedLedger.lanes[0].status, "RUNNING");
  assert.equal(typeof limitedLedger.lanes[0].path, "string");

  const both = gitRepo();
  const [first, second] = await Promise.all([
    startInChild(both, "unit-1", 2),
    startInChild(both, "unit-2", 2),
  ]);
  for (const result of [first, second]) {
    assert.equal(result.status, 0, result.stderr);
  }
  const bothResults = [first, second].map((result) =>
    JSON.parse(result.stdout),
  );
  assert.deepEqual(
    bothResults.map((result) => result.ok),
    [true, true],
  );
  const ledger = readLaneFile(both, "lane-run");
  assert.deepEqual(
    ledger.lanes.map((lane) => lane.unit),
    ["unit-1", "unit-2"],
  );
  assert.ok(
    ledger.lanes.every(
      (lane) => lane.status === "RUNNING" && typeof lane.path === "string",
    ),
  );
});
