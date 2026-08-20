import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { buildRunGateReminder } from "../../scripts/lib/run-gate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(__dirname, "../../skills");

const BOOTSTRAP_MARKER = "NEXUS_ROUTER_V5";
const GATE_MARKER = "NEXUS_DELEGATION_GATE";
const TERMINAL_RUN_STATES = new Set(["COMPLETED", "FAILED"]);
const KNOWLEDGE_RELEVANT_STATES = new Set([
  "BRAINSTORMING",
  "WAITING_FOR_USER",
  "PLANNED",
  "TASK_IMPACT_READY",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "FINAL_VERIFYING",
  "BLOCKED",
]);

function buildCompactRouter() {
  return [
    "<EXTREMELY_IMPORTANT>",
    BOOTSTRAP_MARKER,
    "OpenCode Nexus V5 is installed. Keep this routing pointer compact and load detailed instructions only with the native skill tool when the phase requires them.",
    "Route: start/orient → using-nexus; clarify only if ambiguous → brainstorming; always write a plan → writing-plans; before every implementer → impact-analysis (nexus impact); execute the plan → orchestrating; isolate work → using-feature-branches; finish → finishing-a-development-branch; stuck/BLOCKED → reconcile.",
    "Three invariants: (1) brainstorm then PLAN.md for every request (2) fresh pre-impact before every implementer dispatch including REQUEST_CHANGES fix loops (3) every task needs independent reviewer APPROVED.",
    "Portable commands: nexus project-init | nexus next | nexus run ... | nexus impact ... | nexus estimate ...",
    "Use nexus run for state machine gates. Use nexus next (or the injected Nexus Next Action block) for the deterministic next step — including REQUIRED_DISPATCH agent. Do NOT assume repo-local scripts/ exists.",
    "Agents only: orchestrator, implementer, reviewer. Orchestrator must Task-dispatch implementer for production code and reviewer after VERIFYING. Never self-implement. Never skip reviewer. Do not use legacy classify/blast/Graphify workflow routing, profile matrices, or dual review agents.",
    "Lifecycle: CREATED → BRAINSTORMING ↔ WAITING_FOR_USER → PLANNED → TASK_IMPACT_READY → IMPLEMENTING → VERIFYING → REVIEWING → (REQUEST_CHANGES → TASK_IMPACT_READY) → FINAL_VERIFYING → COMPLETED.",
    "</EXTREMELY_IMPORTANT>",
  ].join("\n");
}

function getBootstrapText() {
  return buildCompactRouter();
}

function readContextFile(worktree) {
  const contextPath = path.join(worktree, ".opencode", "CONTEXT.md");
  if (!fs.existsSync(contextPath)) return null;
  const data = fs.readFileSync(contextPath, "utf8").trim();
  return data.length > 0 ? data : null;
}

function readPlanFile(worktree) {
  const planPath = path.join(worktree, ".opencode", "plans", "PLAN.md");
  if (!fs.existsSync(planPath)) return null;
  return fs.readFileSync(planPath, "utf8").trim();
}

function readRunStateSummary(worktree) {
  const runsRoot = path.join(worktree, ".opencode", "runs");
  if (!fs.existsSync(runsRoot)) return null;
  try {
    const dirs = fs
      .readdirSync(runsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    let best = null;
    for (const id of dirs) {
      const p = path.join(runsRoot, id, "state.json");
      if (!fs.existsSync(p)) continue;
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      if (TERMINAL_RUN_STATES.has(s.state)) continue;
      if (!best || (s.updated_at || "") > (best.updated_at || "")) best = s;
    }
    if (!best) return null;
    const lines = [
      "## Nexus Run State",
      `- run_id: ${best.run_id}`,
      `- state: ${best.state}`,
      `- workflow: ${best.workflow || "default"}`,
      `- current_unit: ${best.current_unit || "n/a"}`,
      `- transitions: ${(best.transitions || []).length}`,
    ];
    return { text: lines.join("\n"), state: best };
  } catch {
    return null;
  }
}

function readReconcileSummary(worktree) {
  const reconcileDir = path.join(worktree, ".opencode", "reconcile");
  try {
    if (!fs.existsSync(reconcileDir)) return null;
    const files = fs
      .readdirSync(reconcileDir)
      .filter((f) => f.startsWith("reconcile-") && f.endsWith(".md"))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const latest = path.join(reconcileDir, files[0]);
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

function partHasMarker(part, marker) {
  return (
    part?.type === "text" &&
    typeof part.text === "string" &&
    part.text.includes(marker)
  );
}

function injectTextPart(
  message,
  text,
  { marker, replace = false, position = "start" } = {},
) {
  if (!message.parts) message.parts = [];
  if (replace) {
    const idx = message.parts.findIndex((p) => partHasMarker(p, marker));
    if (idx >= 0) {
      message.parts[idx] = { ...message.parts[idx], type: "text", text };
      return;
    }
  }
  const already = message.parts.some((p) => partHasMarker(p, marker));
  if (already) return;
  const part = { type: "text", text };
  if (position === "end") message.parts.push(part);
  else message.parts.unshift(part);
}

export const NexusPlugin = async ({ worktree }) => {
  const homeDir = os.homedir();
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
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!output.messages || output.messages.length === 0) return;
      const userMessage = findLatestUserMessage(output.messages);
      if (
        !userMessage ||
        !userMessage.parts ||
        userMessage.parts.length === 0
      ) {
        return;
      }

      const bootstrap = getBootstrapText();
      const priorMarkers = [
        "NEXUS_BOOTSTRAP_V1",
        "NEXUS_BOOTSTRAP_V2",
        "NEXUS_BOOTSTRAP_V3",
        "NEXUS_ROUTER_V3",
        "NEXUS_ROUTER_V5",
      ];
      const sessionHasBootstrap = output.messages.some(
        (message) =>
          Array.isArray(message?.parts) &&
          message.parts.some(
            (p) =>
              partHasMarker(p, BOOTSTRAP_MARKER) ||
              (p?.type === "text" &&
                typeof p.text === "string" &&
                priorMarkers.some((m) => p.text.includes(m))),
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

    "experimental.session.compacting": async (_input, output) => {
      if (!worktree) return;

      const activeRun = readRunStateSummary(worktree);
      if (!activeRun) return;

      const chunks = [];
      const liveContext = readContextFile(worktree);
      if (liveContext) {
        chunks.push("## Nexus Live Context\n" + liveContext.slice(0, 1200));
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
