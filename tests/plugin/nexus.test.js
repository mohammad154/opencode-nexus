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
  const injected = output.messages[0].parts[0].text;
  assert.match(injected, /NEXUS_ROUTER_V3/);
  assert.match(injected, /native skill tool/);
  assert.ok(injected.length < 1600, `router too large: ${injected.length}`);
  assert.equal(injected.includes("The using-nexus skill content below"), false);
  assert.match(injected, /→ using-nexus/);
  assert.match(injected, /→ brainstorming/);
  assert.match(injected, /→ writing-plans/);
  assert.match(injected, /→ knowledge-graph/);
  assert.match(injected, /→ blast-radius/);
  assert.match(injected, /→ orchestrating/);
  assert.equal(injected.includes("nexus-using-nexus"), false);
  assert.equal(injected.includes("nexus-brainstorming"), false);

  const partCount = output.messages[0].parts.length;
  await plugin["experimental.chat.messages.transform"]({}, output);
  assert.equal(output.messages[0].parts.length, partCount);
});

test("compaction omits run and knowledge summaries without an active run", async () => {
  const worktree = tempDir("nexus-plugin-idle-");
  fs.mkdirSync(path.join(worktree, ".opencode", "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(worktree, ".opencode", "knowledge", "graph.md"), "large graph");
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
  fs.mkdirSync(path.join(worktree, ".opencode", "knowledge"), { recursive: true });
  fs.writeFileSync(
    path.join(worktree, ".opencode", "knowledge", "graph.md"),
    "graph summary",
  );
  fs.writeFileSync(
    path.join(worktree, ".opencode", "knowledge", "LESSONS.md"),
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
