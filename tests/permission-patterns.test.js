import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  evaluatePermissionRules,
  permissionPatternMatches,
} from "../scripts/lib/permission-match.js";
import { runPermissionSelfTest } from "../scripts/lib/permission-self-test.js";

test("absolute .opencode paths match the orchestrator allow", () => {
  const rules = {
    "*": "deny",
    "**/*": "ask",
    ".opencode/**": "allow",
    "**/.opencode/**": "allow",
    "AGENTS.md": "allow",
    "**/AGENTS.md": "allow",
    "**/*..*": "deny",
  };
  assert.equal(evaluatePermissionRules(rules, "/app/.opencode/plans/PLAN.md"), "allow");
  assert.equal(
    evaluatePermissionRules(rules, "C:\\app\\.opencode\\plans\\PLAN.md"),
    "allow",
  );
  assert.equal(evaluatePermissionRules(rules, ".opencode/plans/PLAN.md"), "allow");
  assert.equal(evaluatePermissionRules(rules, "/app/AGENTS.md"), "allow");
  assert.equal(evaluatePermissionRules(rules, "/app/src/app.js"), "ask");
  assert.equal(
    evaluatePermissionRules(rules, "/app/.opencode/../../etc/passwd"),
    "deny",
  );
});

test("implementer control-plane denies win for absolute and relative paths", () => {
  const rules = {
    "*": "allow",
    ".opencode/runs/**": "deny",
    "**/.opencode/runs/**": "deny",
    ".opencode/plans/**": "deny",
    "**/.opencode/plans/**": "deny",
    ".opencode/handoffs/**": "allow",
    "**/.opencode/handoffs/**": "allow",
    "**/*..*": "deny",
  };
  assert.equal(
    evaluatePermissionRules(rules, "/app/.opencode/runs/state.json"),
    "deny",
  );
  assert.equal(evaluatePermissionRules(rules, ".opencode/runs/state.json"), "deny");
  assert.equal(evaluatePermissionRules(rules, "/app/.opencode/plans/PLAN.md"), "deny");
  assert.equal(
    evaluatePermissionRules(rules, "/app/.opencode/handoffs/unit-implementer.json"),
    "allow",
  );
  assert.equal(evaluatePermissionRules(rules, "/app/src/app.js"), "allow");
  assert.equal(permissionPatternMatches("**/@mohammad154/opencode-nexus/**", "/root/.nvm/versions/node/v22.21.0/lib/node_modules/@mohammad154/opencode-nexus/package.json"), true);
});

test("bash last-match keeps discard checkout as ask and allows probes", () => {
  const rules = {
    "*": "deny",
    "git checkout*": "allow",
    "git commit*": "allow",
    "ls*": "allow",
    "git checkout --*": "ask",
  };
  assert.equal(evaluatePermissionRules(rules, "ls -la /app"), "allow");
  assert.equal(evaluatePermissionRules(rules, "git commit -m nexus-baseline"), "allow");
  assert.equal(evaluatePermissionRules(rules, "git checkout -b feature"), "allow");
  assert.equal(evaluatePermissionRules(rules, "git checkout -- secrets.env"), "ask");
  assert.equal(evaluatePermissionRules(rules, "rm -rf /"), "deny");
});

test("permission self-test allows an orchestrator plan write and removes the probe", () => {
  const result = runPermissionSelfTest();
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(fs.existsSync(path.dirname(path.dirname(path.dirname(result.probe)))), false);
});
