import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  assessDrift,
  isPlanCommitAcceptable,
} from "../../scripts/lib/drift.js";

test("commit distance >50 alone is MEDIUM not HIGH", () => {
  const r = assessDrift({
    commit_distance: 60,
    plan_commit: "a",
    current_head: "b",
  });
  assert.equal(r.drift, "MEDIUM");
  assert.equal(isPlanCommitAcceptable(r), true);
});

test("broken line anchor is HIGH", () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-drift-"));
  const f = path.join(wt, "src.js");
  fs.writeFileSync(f, "const x = 1;\n", "utf8");
  const r = assessDrift({
    worktree: wt,
    commit_distance: 2,
    anchors: [{ file: "src.js", line: 99, text: "missing" }],
  });
  assert.equal(r.drift, "HIGH");
  assert.equal(isPlanCommitAcceptable(r), false);
});

test("signature change is HIGH", () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-drift-"));
  fs.writeFileSync(
    path.join(wt, "svc.js"),
    "function createUser() {}\n",
    "utf8",
  );
  const r = assessDrift({
    worktree: wt,
    targets: [{ file: "svc.js", signature: "UserService.createUser" }],
  });
  assert.equal(r.drift, "HIGH");
  assert.ok(r.reasons.some((x) => /signature/i.test(x)));
});

test("none when clean", () => {
  const r = assessDrift({ commit_distance: 1 });
  assert.equal(r.drift, "NONE");
});
