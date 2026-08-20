import test from "node:test";
import assert from "node:assert/strict";
import { NexusPlugin } from "../../.opencode/plugins/nexus.js";
import fs from "fs";
import os from "os";
import path from "path";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("router bootstrap is injected once per session across multiple user turns", async () => {
  const worktree = tempDir("nexus-router-once-");
  const plugin = await NexusPlugin({ worktree });

  // Turn 1: a single user message. Bootstrap should be injected.
  const output = {
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "first message" }] },
    ],
  };
  await plugin["experimental.chat.messages.transform"]({}, output);
  const firstJoined = output.messages[0].parts.map((p) => p.text || "").join("\n");
  assert.match(firstJoined, /NEXUS_ROUTER_V5/);

  // Turn 2: assistant reply + a brand-new user message that does NOT contain
  // the marker. The bootstrap must NOT be injected again into the new message.
  output.messages.push({ info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] });
  output.messages.push({
    info: { role: "user" },
    parts: [{ type: "text", text: "second message" }],
  });

  await plugin["experimental.chat.messages.transform"]({}, output);
  const secondUser = output.messages[output.messages.length - 1];
  const secondJoined = secondUser.parts.map((p) => p.text || "").join("\n");
  assert.equal(
    secondJoined.includes("NEXUS_ROUTER_V5"),
    false,
    "router bootstrap must not be re-injected on a later user turn",
  );

  // The marker should exist exactly once across the whole session.
  const totalMarkers = output.messages
    .flatMap((m) => m.parts || [])
    .filter((p) => typeof p.text === "string" && p.text.includes("NEXUS_ROUTER_V5"))
    .length;
  assert.equal(totalMarkers, 1);
});
