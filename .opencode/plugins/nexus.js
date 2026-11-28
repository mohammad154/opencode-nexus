import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { buildRunGateReminder } from "../../scripts/lib/run-gate.js";
import { latestActiveRunState } from "../../scripts/lib/migrate-artifacts.js";
import { validateContainedPath } from "../../scripts/lib/filesystem-boundary.js";
import { assessOrchestratorEdit, assessToolEdit } from "../../scripts/lib/orchestrator-edit.js";
import { isDirectFastPath } from "../../scripts/lib/fast-path.js";
import {
  abortSubagentSession,
  createSubagentWatchdog,
  loadRoleBudgets,
  recordSubagentTimeout,
} from "../../scripts/lib/subagent-budget.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(__dirname, "../../skills");
const defaultModelsFile = path.resolve(__dirname, "../../config/default-models.json");

function readInstalledModels(worktree) {
  const configDir =
    process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode");
  const files = [
    defaultModelsFile,
    path.join(configDir, "nexus.models.json"),
  ];
  if (worktree) files.push(path.join(worktree, ".opencode", "nexus.models.json"));
  const merged = {};
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data && typeof data === "object" && !Array.isArray(data)) Object.assign(merged, data);
    } catch {
      // A missing override keeps the previous layer.
    }
  }
  return merged;
}

const BOOTSTRAP_MARKER = "NEXUS_ROUTER_V5";
const GATE_MARKER = "NEXUS_DELEGATION_GATE";
const PRIOR_BOOTSTRAP_MARKERS = [
  "NEXUS_BOOTSTRAP_V1",
  "NEXUS_BOOTSTRAP_V2",
  "NEXUS_BOOTSTRAP_V3",
  "NEXUS_ROUTER_V3",
  BOOTSTRAP_MARKER,
];
const KNOWLEDGE_RELEVANT_STATES = new Set([
  "BRAINSTORMING",
  "WAITING_FOR_USER",
  "PLANNED",
  "TASK_IMPACT_READY",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "FINAL_REVIEWING",
  "FINAL_VERIFYING",
  "BLOCKED",
]);

function buildCompactRouter() {
  return [
    "<EXTREMELY_IMPORTANT>",
    BOOTSTRAP_MARKER,
    "Nexus workflow protocol v5 installed (the npm package remains on its 4.x release line). Load detailed instructions only with the native skill tool when needed.",
    "Route: start → nexus-using-nexus; clarify → nexus-brainstorming; plan → nexus-writing-plans; advisor → plan-advisor; check → PLANNED; pre-impact → nexus-impact-analysis; units → nexus-orchestrating; branches → nexus-using-feature-branches; finish → nexus-finishing-a-development-branch; blocked → nexus-reconcile.",
    "Autonomy: after the plan is confirmed, continue safe commands and Task-dispatches in the same turn. Do not ask to continue, test, review, fix, merge, or clean up under the default policy; ask only for plan decisions or critical irreversible/external approval.",
    "Three invariants: (1) direct mode: five-line plan, no PLAN.md/advisor/branch; else brainstorm then PLAN.md (2) fresh pre-impact before standard implementer dispatch (3) reviewer APPROVED; direct mode reviews on second failure or HIGH risk.",
    "State: active-run/state.json, not CONTEXT.md. Never reset/restore/clean/delete files.",
    "Portable commands: nexus project-init | nexus next | nexus run ... | nexus impact ... | nexus estimate ...",
    "Use nexus run for gates and nexus next for the deterministic next step, including REQUIRED_DISPATCH. Do not assume repo-local scripts/ exists.",
    "Execution: orchestrator, implementer, reviewer; plan-advisor only while planning. Reviewer follows PASSED verification; verification is deterministic. Direct mode: edit <=20 lines or one implementer.",
    "Lifecycle: CREATED → BRAINSTORMING ↔ WAITING_FOR_USER → PLANNED → TASK_IMPACT_READY → IMPLEMENTING → VERIFYING → REVIEWING → FINAL_REVIEWING → FINAL_VERIFYING → COMPLETED. Follow nexus next for timeout resume, one sealed repair, review packages, and final approval; never create a verifier subagent.",
    "</EXTREMELY_IMPORTANT>",
  ].join("\n");
}

function getBootstrapText() {
  return buildCompactRouter();
}

function safeRuntimeFile(worktree, relativePath) {
  const root = path.resolve(worktree);
  const candidate = path.resolve(root, relativePath);
  const boundary = validateContainedPath(root, candidate, {
    allowMissing: true,
    rejectSymlinks: true,
  });
  return boundary.ok ? candidate : null;
}

function readContextFile(worktree, runState = null) {
  const contextPath = safeRuntimeFile(
    worktree,
    path.join(".opencode", "CONTEXT.md"),
  );
  if (!contextPath) return { text: null, warning: null };
  if (!fs.existsSync(contextPath)) return { text: null, warning: null };
  const data = fs.readFileSync(contextPath, "utf8").trim();
  if (data.length === 0) return { text: null, warning: null };

  // CONTEXT.md is an optional, human-maintained note. It is commonly read by
  // OpenCode as a system reminder, so never carry a declared stale phase/run
  // across compaction when durable state disagrees.
  const declaredRun = data.match(/^- Active run:\s*([^\s(]+)/m)?.[1];
  if (declaredRun && runState?.run_id && declaredRun !== runState.run_id) {
    return {
      text: null,
      warning:
        `CONTEXT.md omitted: it declares run ${declaredRun}, but durable state declares ${runState.run_id}.`,
    };
  }

  const declaredPhase = data.match(/^- Current phase:\s*([A-Z_]+)/m)?.[1];
  if (declaredPhase && runState?.state && declaredPhase !== runState.state) {
    return {
      text: null,
      warning:
        `CONTEXT.md omitted: it declares phase ${declaredPhase}, but durable state declares ${runState.state}.`,
    };
  }

  return { text: data, warning: null };
}

function readPlanFile(worktree) {
  const planPath = safeRuntimeFile(
    worktree,
    path.join(".opencode", "plans", "PLAN.md"),
  );
  if (!planPath) return null;
  if (!fs.existsSync(planPath)) return null;
  return fs.readFileSync(planPath, "utf8").trim();
}

function readRunStateSummary(worktree) {
  const best = latestActiveRunState(worktree);
  if (!best) return null;
  try {
    const lines = [
      "## Nexus Run State",
      `- run_id: ${best.run_id}`,
      `- state: ${best.state}`,
      `- workflow: ${best.workflow || "default"}`,
      `- current_unit: ${best.current_unit || "n/a"}`,
      `- transitions: ${(best.transitions || []).length}`,
    ];
    if (best.verification?.status || best.verification_status) {
      lines.push(
        `- verification: ${(best.verification?.phase || "n/a")} / ${best.verification?.status || best.verification_status}`,
      );
      if (best.verification?.current_step != null && best.verification?.total_steps != null) {
        lines.push(
          `- verification_progress: ${best.verification.current_step}/${best.verification.total_steps}`,
        );
      }
    }
    return { text: lines.join("\n"), state: best };
  } catch {
    return null;
  }
}

function readReconcileSummary(worktree) {
  const reconcileDir = safeRuntimeFile(
    worktree,
    path.join(".opencode", "reconcile"),
  );
  if (!reconcileDir) return null;
  try {
    if (!fs.existsSync(reconcileDir)) return null;
    const files = fs
      .readdirSync(reconcileDir)
      .filter((f) => f.startsWith("reconcile-") && f.endsWith(".md"))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const latest = safeRuntimeFile(
      worktree,
      path.join(".opencode", "reconcile", files[0]),
    );
    if (!latest) return null;
    const txt = fs.readFileSync(latest, "utf8").trim();
    return "## Nexus Last Reconcile\n" + txt.slice(0, 600);
  } catch {
    return null;
  }
}

function summarizePlan(planText) {
  const lines = planText.split("\n").map((line) => line.trim());
  const bullets = [];
  for (const line of lines) {
    if (
      line.startsWith("- [ ]") ||
      line.startsWith("- [x]") ||
      line.startsWith("## ") ||
      line.startsWith("> Generated") ||
      line.startsWith("> Drift") ||
      line.startsWith("Effort:")
    ) {
      bullets.push(line);
    }
    if (bullets.length >= 8) break;
  }
  return bullets.length > 0 ? bullets.join("\n") : planText.slice(0, 800);
}

function buildGateInjection(worktree) {
  const activeRun = readRunStateSummary(worktree);
  const gate = buildRunGateReminder(activeRun?.state ?? null, { worktree });
  if (!gate) return null;
  return `<EXTREMELY_IMPORTANT>\n${GATE_MARKER}\n${gate}\n</EXTREMELY_IMPORTANT>`;
}

function findLatestUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.info?.role === "user") return messages[i];
  }
  return null;
}

function readDeclaredAgent(value) {
  return typeof value === "string" ? value : null;
}

function findExplicitAgent(input) {
  const candidates = [
    input?.agent,
    input?.primaryAgent,
    input?.message?.agent,
    input?.message?.info?.agent,
  ].filter((value) => value !== undefined);
  if (candidates.length === 0) return null;

  const declared = candidates.map(readDeclaredAgent);
  if (declared.some((value) => value === null)) return null;
  return declared.every((value) => value === declared[0]) ? declared[0] : null;
}

function resolveChatAgent(input, messages) {
  const latest = findLatestUserMessage(messages);
  const messageAgent = latest?.info?.agent;
  if (messageAgent !== undefined) {
    const declared = readDeclaredAgent(messageAgent);
    const explicit = findExplicitAgent(input);
    if (explicit !== null && explicit !== declared) return null;
    return declared;
  }
  return findExplicitAgent(input);
}

function resolveSessionId(input, messages) {
  const latest = findLatestUserMessage(messages);
  return (
    (typeof input?.sessionID === "string" && input.sessionID) ||
    (typeof latest?.info?.sessionID === "string" && latest.info.sessionID) ||
    null
  );
}

function resolveCompactionAgent(input, sessionAgents) {
  const direct = findExplicitAgent(input);
  const sessionID = typeof input?.sessionID === "string" ? input.sessionID : null;
  const remembered = sessionID && sessionAgents.has(sessionID)
    ? sessionAgents.get(sessionID)
    : undefined;
  if (direct !== null && remembered !== undefined && direct !== remembered) {
    return null;
  }
  return direct !== null ? direct : (remembered ?? null);
}

function partHasMarker(part, marker) {
  return (
    part?.type === "text" &&
    typeof part.text === "string" &&
    part.text.includes(marker)
  );
}

function isNexusOwnedPart(part) {
  if (part?.type !== "text" || typeof part.text !== "string") return false;
  const text = part.text.trimStart();
  const wrapped = (
    text.startsWith("<EXTREMELY_IMPORTANT>") &&
    [GATE_MARKER, ...PRIOR_BOOTSTRAP_MARKERS].some((marker) =>
      text.includes(marker),
    )
  );
  const explicitMarker = [GATE_MARKER, ...PRIOR_BOOTSTRAP_MARKERS].some(
    (marker) => text === marker || text.startsWith(`${marker}\n`),
  );
  return wrapped || explicitMarker;
}

function sanitizeNexusParts(messages) {
  for (const message of messages || []) {
    if (!Array.isArray(message?.parts)) continue;
    message.parts = message.parts.filter((part) => !isNexusOwnedPart(part));
  }
}

function injectTextPart(
  message,
  text,
  { marker, replace = false, position = "start" } = {},
) {
  if (!message.parts) message.parts = [];
  if (replace) {
    const idx = message.parts.findIndex(
      (p) => isNexusOwnedPart(p) && partHasMarker(p, marker),
    );
    if (idx >= 0) {
      message.parts[idx] = { ...message.parts[idx], type: "text", text };
      return;
    }
  }
  const already = message.parts.some(
    (p) => isNexusOwnedPart(p) && partHasMarker(p, marker),
  );
  if (already) return;
  const part = { type: "text", text };
  if (position === "end") message.parts.push(part);
  else message.parts.unshift(part);
}

export const NexusPlugin = async ({ worktree, client } = {}) => {
  const homeDir = os.homedir();
  const sessionAgents = new Map();
  const watchdog = createSubagentWatchdog({
    budgets: loadRoleBudgets(readInstalledModels(worktree)),
    abortChild: (sessionID) => abortSubagentSession(client, sessionID),
    onTimeout(event) {
      try {
        const runState = worktree ? latestActiveRunState(worktree) : null;
        if (!worktree || !runState?.run_id || !event.callID) return;
        recordSubagentTimeout(worktree, {
          ...event,
          run_id: runState.run_id,
          unit: runState.current_unit || "unit-1",
        });
      } catch {
        // The watchdog also swallows callback errors. A timeout must not crash the host.
      }
    },
  });
  const configDir =
    process.env.OPENCODE_CONFIG_DIR ||
    path.join(homeDir, ".config", "opencode");

  return {
    config: async (config) => {
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(skillsDir)) {
        config.skills.paths.push(skillsDir);
      }
      config.nexus = config.nexus || {};
      config.nexus.configDir = configDir;
      config.permission = config.permission || {};
      const external = config.permission.external_directory || {};
      const packageGlob = "**/@mohammad154/opencode-nexus/**";
      if (!external[packageGlob]) external[packageGlob] = "allow";
      const schemaGlob = "**/@mohammad154/opencode-nexus/schemas/*";
      if (!external[schemaGlob]) external[schemaGlob] = "allow";
      const cacheGlob = "**/.cache/opencode/packages/@mohammad154/**";
      if (!external[cacheGlob]) external[cacheGlob] = "allow";
      config.permission.external_directory = external;
    },

    "tool.execute.before": async (input, output) => {
      const sessionID = input?.sessionID || input?.sessionId || null;
      const agent = sessionAgents.get(sessionID) || input?.agent || null;
      if (sessionID && agent) sessionAgents.set(sessionID, agent);
      watchdog.before(input, output);
      if (!worktree) return;
      const runState = latestActiveRunState(worktree);
      const decision = assessToolEdit({
        agent,
        worktree,
        input,
        args: output?.args || input?.args || {},
        runState,
      });
      if (decision && decision.ok === false) {
        throw new Error(decision.reason || "Nexus blocked this edit");
      }
    },

    "tool.execute.after": async (input) => {
      const parent = input?.sessionID || input?.sessionId || null;
      const child = input?.metadata?.sessionID || input?.metadata?.sessionId || null;
      if (parent && child) watchdog.noteChildSession(parent, child);
      watchdog.after(input);
    },

    "permission.ask": async (input, output) => {
      const kind = input?.permission || input?.type;
      if (kind !== "edit") return;
      const sessionID = input?.sessionID || input?.sessionId || null;
      const agent = sessionAgents.get(sessionID) || input?.agent || null;
      if (agent !== "orchestrator" || !output) return;
      const pattern = input?.pattern || input?.patterns?.[0] || null;
      const runState = worktree ? latestActiveRunState(worktree) : null;
      const decision = assessOrchestratorEdit({
        worktree,
        filePath: pattern,
        args: {},
        runState,
      });
      if (decision.ok && isDirectFastPath(runState)) output.status = "allow";
      else if (!decision.ok) output.status = "deny";
    },

    event: async (input) => {
      const properties = input?.event?.properties || input?.properties || {};
      const info = properties.info || {};
      const parent = info.parentID || properties.parentID || null;
      const child = info.id || properties.sessionID || null;
      if (parent && child) watchdog.noteChildSession(parent, child);
    },

    "experimental.chat.messages.transform": async (input, output) => {
      if (!output.messages || output.messages.length === 0) return;
      const agent = resolveChatAgent(input, output.messages);
      const sessionID = resolveSessionId(input, output.messages);
      if (sessionID) sessionAgents.set(sessionID, agent);

      // The plugin is deliberately inert for every agent except the exact
      // primary agent name "orchestrator". Remove only explicit Nexus-owned
      // sections when a conversation switches away from that agent; user
      // authored text remains untouched.
      if (agent !== "orchestrator") {
        sanitizeNexusParts(output.messages);
        return;
      }

      const userMessage = findLatestUserMessage(output.messages);
      if (
        !userMessage ||
        !userMessage.parts ||
        userMessage.parts.length === 0
      ) {
        return;
      }

      const bootstrap = getBootstrapText();
      const sessionHasBootstrap = output.messages.some(
        (message) =>
          Array.isArray(message?.parts) &&
          message.parts.some(
            (p) => isNexusOwnedPart(p) &&
              PRIOR_BOOTSTRAP_MARKERS.some((m) => partHasMarker(p, m)),
          ),
      );

      if (bootstrap && !sessionHasBootstrap) {
        injectTextPart(userMessage, bootstrap, { marker: BOOTSTRAP_MARKER });
      }

      if (worktree) {
        const gateText = buildGateInjection(worktree);
        if (gateText) {
          injectTextPart(userMessage, gateText, {
            marker: GATE_MARKER,
            replace: true,
            position: "end",
          });
        }
      }
    },

    "experimental.session.compacting": async (input, output) => {
      if (resolveCompactionAgent(input, sessionAgents) !== "orchestrator") {
        return;
      }
      if (!worktree) return;

      const activeRun = readRunStateSummary(worktree);
      if (!activeRun) return;

      const chunks = [];
      const liveContext = readContextFile(worktree, activeRun.state);
      if (liveContext.text) {
        chunks.push("## Nexus Live Context\n" + liveContext.text.slice(0, 1200));
      } else if (liveContext.warning) {
        chunks.push("## Nexus Context Status\n- " + liveContext.warning);
      }

      chunks.push(activeRun.text);

      const gate = buildRunGateReminder(activeRun.state, { worktree });
      if (gate) {
        chunks.push(gate);
      }

      chunks.push(
        [
          "## Nexus Active Artifact Pointers",
          "- plan: .opencode/plans/PLAN.md",
          "- impact: nexus impact --json",
          "- metrics: .opencode/runs/" +
            activeRun.state.run_id +
            "/metrics.jsonl",
          "- commands: nexus next | nexus run | nexus impact | nexus estimate",
        ].join("\n"),
      );

      if (KNOWLEDGE_RELEVANT_STATES.has(activeRun.state.state)) {
        const plan = readPlanFile(worktree);
        if (plan) {
          chunks.push("## Nexus Plan Snapshot\n" + summarizePlan(plan));
        }

        const reconcile = readReconcileSummary(worktree);
        if (reconcile) {
          chunks.push(reconcile);
        }
      }

      if (chunks.length > 0) {
        output.context = output.context || [];
        output.context.push(chunks.join("\n\n"));
      }
    },
  };
};

export default NexusPlugin;
