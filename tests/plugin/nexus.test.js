import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { NexusPlugin } from "../../.opencode/plugins/nexus.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

test("plugin injects a compact router and keeps automatic skill routing", async () => {
  const worktree = tempDir("nexus-plugin-");
  const plugin = await NexusPlugin({ worktree });
  const config = {};
  await plugin.config(config);
  assert.ok(config.skills.paths.some((entry) => entry.endsWith("/skills")));

  const output = {
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "work" }] },
    ],
  };
  await plugin["experimental.chat.messages.transform"]({}, output);
  const injected = output.messages[0].parts.map((p) => p.text || "").join("\n");
  assert.match(injected, /NEXUS_ROUTER_V3/);
  assert.match(injected, /native skill tool/);
  assert.match(injected, /nexus project-init/);
  assert.match(injected, /nexus run/);
  assert.ok(injected.length < 2200, `router too large: ${injected.length}`);
  assert.equal(injected.includes("The using-nexus skill content below"), false);
  assert.match(injected, /→ using-nexus/);
  assert.match(injected, /→ brainstorming/);
  assert.match(injected, /→ writing-plans/);
  assert.match(injected, /Graphify query\/affected/);
  assert.match(injected, /→ blast-radius/);
  assert.match(injected, /→ orchestrating/);
  assert.equal(injected.includes("nexus-using-nexus"), false);
  assert.equal(injected.includes("nexus-brainstorming"), false);

  const partCount = output.messages[0].parts.length;
  await plugin["experimental.chat.messages.transform"]({}, output);
  assert.equal(output.messages[0].parts.length, partCount);
});

test("compaction omits run and Graphify summaries without an active run", async () => {
  const worktree = tempDir("nexus-plugin-idle-");
  fs.mkdirSync(path.join(worktree, "graphify-out"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "graphify-out", "GRAPH_REPORT.md"), "large graph");
  writeJson(path.join(worktree, ".opencode", "runs", "done", "state.json"), {
    run_id: "done",
    state: "COMPLETED",
    updated_at: "2026-07-30T12:00:00.000Z",
  });

  const plugin = await NexusPlugin({ worktree });
  const output = { context: [] };
  await plugin["experimental.session.compacting"]({}, output);
  assert.deepEqual(output.context, []);
});

test("compaction adds only compact active-run context and artifact pointers", async () => {
  const worktree = tempDir("nexus-plugin-active-");
  fs.mkdirSync(path.join(worktree, "graphify-out", "reflections"), { recursive: true });
  fs.writeFileSync(
    path.join(worktree, "graphify-out", "GRAPH_REPORT.md"),
    "graph summary",
  );
  fs.writeFileSync(
    path.join(worktree, "graphify-out", "reflections", "LESSONS.md"),
    "recent lesson",
  );
  fs.mkdirSync(path.join(worktree, ".opencode", "plans"), { recursive: true });
  fs.writeFileSync(
    path.join(worktree, ".opencode", "plans", "PLAN.md"),
    "## Active unit\n- [ ] Keep the run small\n",
  );
  writeJson(path.join(worktree, ".opencode", "runs", "active", "state.json"), {
    run_id: "active",
    state: "IMPLEMENTING",
    profile: "balanced",
    review_level: "unified",
    execution_mode: "delegated",
    current_unit: "provider-unit",
    transitions: [],
    updated_at: "2026-07-30T12:00:00.000Z",
  });

  const plugin = await NexusPlugin({ worktree });
  const output = {};
  await plugin["experimental.session.compacting"]({}, output);
  assert.equal(output.context.length, 1);
  assert.match(output.context[0], /Nexus Run State/);
  assert.match(output.context[0], /Active Artifact Pointers/);
  assert.match(output.context[0], /\.opencode\/plans\/PLAN\.md/);
  assert.match(output.context[0], /Keep the run small/);
  assert.match(output.context[0], /recent lesson/);
});

test("chat transform injects delegation gate when no active run", async () => {
  const worktree = tempDir("nexus-plugin-gate-");
  const plugin = await NexusPlugin({ worktree });
  const output = {
    messages: [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "implement feature" }],
      },
    ],
  };
  await plugin["experimental.chat.messages.transform"]({}, output);
  const injected = output.messages[0].parts.map((p) => p.text || "").join("\n");
  assert.match(injected, /NEXUS_DELEGATION_GATE/);
  assert.match(injected, /No active Nexus run/);
  assert.match(injected, /nexus project-init/);
});

test("chat transform injects IMPLEMENTING dispatch gate", async () => {
  const worktree = tempDir("nexus-plugin-impl-gate-");
  writeJson(path.join(worktree, ".opencode", "runs", "active", "state.json"), {
    run_id: "active",
    state: "IMPLEMENTING",
    profile: "balanced",
    updated_at: "2026-07-30T12:00:00.000Z",
  });
  const plugin = await NexusPlugin({ worktree });
  const output = {
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
    ],
  };
  await plugin["experimental.chat.messages.transform"]({}, output);
  const injected = output.messages[0].parts.map((p) => p.text || "").join("\n");
  assert.match(injected, /IMPLEMENTING/);
  assert.match(injected, /Dispatch implementer/);
});

test("compaction includes delegation gate for active run", async () => {
  const worktree = tempDir("nexus-plugin-compact-gate-");
  writeJson(path.join(worktree, ".opencode", "runs", "active", "state.json"), {
    run_id: "active",
    state: "TASK_IMPACT_READY",
    workflow: "default",
    updated_at: "2026-07-30T12:00:00.000Z",
  });
  const plugin = await NexusPlugin({ worktree });
  const output = {};
  await plugin["experimental.session.compacting"]({}, output);
  assert.equal(output.context.length, 1);
  assert.match(output.context[0], /Complete workflow gates/);
});

test("plugin module provides default export and does not leak helper functions", async () => {
  const module = await import("../../.opencode/plugins/nexus.js");
  assert.equal(typeof module.default, "function", "plugin must have a default export function");
  assert.equal(module.default, module.NexusPlugin, "default export must equal NexusPlugin");
  const namedExports = Object.keys(module);
  assert.deepEqual(
    namedExports.sort(),
    ["NexusPlugin", "default"].sort(),
    "plugin module should only export plugin initializer to avoid loader calling helper functions",
  );
});

test("agent permissions place catch-all '*' before specific rules", () => {
  const agentsDir = path.resolve(import.meta.dirname, "../../agents");
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 3);

  for (const file of files) {
    const content = fs.readFileSync(path.join(agentsDir, file), "utf8");
    const lines = content.split("\n");
    let inEdit = false;
    let editKeys = [];

    for (const line of lines) {
      if (line.startsWith("---") && inEdit) break;
      if (/^\s*edit:\s*$/.test(line)) {
        inEdit = true;
        continue;
      }
      if (inEdit) {
        if (/^\s{2}[a-z_]+:/i.test(line) && !line.startsWith("    ")) {
          inEdit = false;
          continue;
        }
        const m = line.match(/^\s{4}"?([^":]+)"?\s*:/);
        if (m) editKeys.push(m[1]);
      }
    }

    if (editKeys.length > 1) {
      assert.equal(
        editKeys[0],
        "*",
        `Agent ${file} edit permissions must define catch-all '*' first so specific rules take precedence`,
      );
    }
  }
});

