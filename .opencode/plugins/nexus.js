import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { buildRunGateReminder } from "../../scripts/lib/run-gate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(__dirname, "../../skills");

const BOOTSTRAP_MARKER = "NEXUS_ROUTER_V3";
const GATE_MARKER = "NEXUS_DELEGATION_GATE";
const TERMINAL_RUN_STATES = new Set(["COMPLETED", "FAILED"]);
const KNOWLEDGE_RELEVANT_STATES = new Set([
  "PLANNED",
  "GRAPH_READY",
  "BLAST_READY",
  "IMPLEMENTING",
  "DIRECT_IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "BLOCKED",
]);

function buildCompactRouter() {
  return [
    "<EXTREMELY_IMPORTANT>",
    BOOTSTRAP_MARKER,
    "OpenCode Nexus is installed. Keep this routing pointer compact and load detailed instructions only with the native skill tool when the phase requires them.",
    "Route: start or orient a Nexus session → using-nexus; unclear requirements → brainstorming; write a plan → writing-plans; map the codebase → Graphify query/affected/update; before edits → blast-radius; execute an approved plan → orchestrating; isolate work → using-feature-branches; finish/reconcile → finishing-a-development-branch or reconcile.",
    "Portable commands (work from any repo): nexus project-init | nexus run ... | nexus blast ... | nexus classify ... | nexus estimate ...",
    "Use nexus run for state machine gates — do NOT assume repo-local scripts/ exists. Clone-dev fallback only when working inside the Nexus package itself.",
    "Orchestrator must dispatch implementer for production code. Never self-implement unless execution_mode: direct or narrow direct_eligible exception.",
    "Use scripts for state, graph, blast, call estimates, and cleanup. Canonical artifacts live under .opencode/. Review policy is profile-aware; never lower a stored safety gate. Automatic skill routing remains available through the configured skills path.",
    "</EXTREMELY_IMPORTANT>",
  ].join("\n");
}

export function getBootstrapText() {
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

export function readRunStateSummary(worktree) {
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
      `- profile: ${best.profile}`,
      `- review_level: ${best.review_level || "n/a"}`,
      `- execution_mode: ${best.execution_mode || "n/a"}`,
      `- current_unit: ${best.current_unit || "n/a"}`,
      `- transitions: ${(best.transitions || []).length}`,
    ];
    return { text: lines.join("\n"), state: best };
  } catch {
    return null;
  }
}

function readGraphifySummary(worktree) {
  const configuredOut = process.env.GRAPHIFY_OUT || "graphify-out";
  const graphifyOut = path.isAbsolute(configuredOut)
    ? path.resolve(configuredOut)
    : path.resolve(worktree, configuredOut);
  const graphReport = path.join(graphifyOut, "GRAPH_REPORT.md");
  const lessons = path.join(graphifyOut, "reflections", "LESSONS.md");
  const reconcileDir = path.join(worktree, ".opencode", "reconcile");
  const parts = [];

  if (fs.existsSync(graphReport)) {
    try {
      const txt = fs.readFileSync(graphReport, "utf8").trim();
      parts.push("## Graphify Knowledge Graph\n" + txt.slice(0, 800));
    } catch {}
  }

  if (fs.existsSync(lessons)) {
    try {
      const txt = fs.readFileSync(lessons, "utf8").trim();
      if (txt.length > 0) {
        const tailLen = 800;
        const slice = txt.length > tailLen ? txt.slice(-tailLen) : txt;
        parts.push("## Graphify Outcome Memory (LESSONS.md tail)\n" + slice);
      }
    } catch {}
  }

  try {
    if (fs.existsSync(reconcileDir)) {
      const files = fs
        .readdirSync(reconcileDir)
        .filter((f) => f.startsWith("reconcile-") && f.endsWith(".md"))
        .sort()
        .reverse();
      if (files.length > 0) {
        const latest = path.join(reconcileDir, files[0]);
        const txt = fs.readFileSync(latest, "utf8").trim();
        parts.push("## Nexus Last Reconcile\n" + txt.slice(0, 600));
      }
    }
  } catch {}

  return parts.length > 0 ? parts.join("\n\n") : null;
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
  const gate = buildRunGateReminder(activeRun?.state ?? null);
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
      const alreadyBootstrap = userMessage.parts.some((p) =>
        partHasMarker(p, BOOTSTRAP_MARKER),
      );
      const priorMarkers = [
        "NEXUS_BOOTSTRAP_V1",
        "NEXUS_BOOTSTRAP_V2",
        "NEXUS_BOOTSTRAP_V3",
      ];
      const alreadyPrior = userMessage.parts.some(
        (p) =>
          p.type === "text" &&
          typeof p.text === "string" &&
          priorMarkers.some((m) => p.text.includes(m)),
      );

      if (bootstrap && !alreadyBootstrap && !alreadyPrior) {
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

      const gate = buildRunGateReminder(activeRun.state);
      if (gate) {
        chunks.push(gate);
      }

      chunks.push(
        [
          "## Nexus Active Artifact Pointers",
          "- plan: .opencode/plans/PLAN.md",
          "- graphify: graphify-out/",
          "- metrics: .opencode/runs/" +
            activeRun.state.run_id +
            "/metrics.jsonl",
          "- commands: nexus run | nexus blast | nexus classify | nexus estimate",
        ].join("\n"),
      );

      if (KNOWLEDGE_RELEVANT_STATES.has(activeRun.state.state)) {
        const plan = readPlanFile(worktree);
        if (plan) {
          chunks.push("## Nexus Plan Snapshot\n" + summarizePlan(plan));
        }

        const graphify = readGraphifySummary(worktree);
        if (graphify) {
          chunks.push(graphify);
        }
      }

      if (chunks.length > 0) {
        output.context = output.context || [];
        output.context.push(chunks.join("\n\n"));
      }
    },
  };
};
