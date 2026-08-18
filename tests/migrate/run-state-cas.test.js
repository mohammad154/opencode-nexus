import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyRunState,
  writeRunState,
  readRunState,
} from "../../scripts/lib/migrate-artifacts.js";

test("optimistic concurrency rejects a stale second writer", (t) => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cas-"));
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));

  writeRunState(wt, createEmptyRunState("r1"));
  const a = readRunState(wt, "r1");
  const b = readRunState(wt, "r1");
  assert.equal(a._revision, b._revision);

  // First writer commits successfully.
  const committed = writeRunState(wt, { ...a, state: "CLASSIFIED" });
  assert.equal(committed._revision, a._revision + 1);

  // Second writer still holds the old revision → conflict.
  assert.throws(
    () => writeRunState(wt, { ...b, state: "PLANNED" }),
    (err) => err.code === "REVISION_CONFLICT",
  );

  // Re-reading yields the new revision; the write then succeeds.
  const fresh = readRunState(wt, "r1");
  const ok = writeRunState(wt, { ...fresh, state: "PLANNED" });
  assert.equal(ok.state, "PLANNED");
});

test("fresh init without a base revision still writes", (t) => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cas-init-"));
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  const state = createEmptyRunState("fresh");
  const written = writeRunState(wt, state);
  assert.equal(written._revision, 1);
});
