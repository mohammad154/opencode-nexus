import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inferRunFromContext } from "../../scripts/lib/migrate-artifacts.js";

function makeWorktree() {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-recover-"));
  fs.mkdirSync(path.join(wt, ".opencode", "handoffs"), { recursive: true });
  return wt;
}

function writeContext(wt, fields) {
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  fs.writeFileSync(path.join(wt, ".opencode", "CONTEXT.md"), `# ctx\n\n${body}\n`);
}

function writeHandoff(wt, name, data, mtime) {
  const file = path.join(wt, ".opencode", "handoffs", name);
  fs.writeFileSync(file, JSON.stringify(data));
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

test("recovery selects the latest implementer handoff by created_at, filtered by run/unit", (t) => {
  const wt = makeWorktree();
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  writeContext(wt, { run_id: "run-a", current_unit: "unit-1" });

  // Older handoff for the same run/unit.
  writeHandoff(wt, "implementer-old.json", {
    run_id: "run-a",
    unit_or_task: "unit-1",
    status: "DONE_WITH_CONCERNS",
    created_at: "2026-08-01T00:00:00.000Z",
  });
  // Newest handoff for the same run/unit.
  writeHandoff(wt, "implementer-new.json", {
    run_id: "run-a",
    unit_or_task: "unit-1",
    status: "DONE",
    created_at: "2026-08-10T00:00:00.000Z",
  });
  // A foreign run's handoff must be ignored even if it sorts last.
  writeHandoff(wt, "implementer-zzz-foreign.json", {
    run_id: "run-b",
    unit_or_task: "unit-9",
    status: "DONE",
    created_at: "2026-08-31T00:00:00.000Z",
  });

  const state = inferRunFromContext(wt);
  assert.equal(state.state, "VERIFYING");
  assert.equal(state.run_id, "run-a");
});

test("ambiguous latest handoffs BLOCK rather than guess", (t) => {
  const wt = makeWorktree();
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  writeContext(wt, { run_id: "run-a", current_unit: "unit-1" });

  const sameTime = new Date("2026-08-10T00:00:00.000Z");
  // Two implementer handoffs with identical (absent) created_at and identical mtime.
  writeHandoff(
    wt,
    "implementer-one.json",
    { run_id: "run-a", unit_or_task: "unit-1", status: "DONE" },
    sameTime.getTime() / 1000,
  );
  writeHandoff(
    wt,
    "implementer-two.json",
    { run_id: "run-a", unit_or_task: "unit-1", status: "DONE" },
    sameTime.getTime() / 1000,
  );

  const state = inferRunFromContext(wt);
  assert.equal(state.state, "BLOCKED");
  assert.equal(state.block_code, "AMBIGUOUS_HANDOFF");
});
