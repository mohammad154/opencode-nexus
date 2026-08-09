import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(__dirname, "../../skills");

const BOOTSTRAP_MARKER = "NEXUS_ROUTER_V3";
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

const COMPACT_ROUTER = [
  "<EXTREMELY_IMPORTANT>",
  BOOTSTRAP_MARKER,
  "OpenCode Nexus is installed. Keep this routing pointer compact and load detailed instructions only with the native skill tool when the phase requires them.",
  "Route: start or orient a Nexus session → using-nexus; unclear requirements → brainstorming; write a plan → writing-plans; map the codebase → Graphify query/affected/update; before edits → blast-radius; execute an approved plan → orchestrating; isolate work → using-feature-branches; finish/reconcile → finishing-a-development-branch or reconcile.",
  "Use scripts for state, graph, blast, call estimates, and cleanup. Canonical artifacts live under .opencode/. Review policy is profile-aware; never lower a stored safety gate. Automatic skill routing remains available through the configured skills path.",
  "</EXTREMELY_IMPORTANT>",
].join("\n");

function getBootstrapText() {
  return COMPACT_ROUTER;
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
        // Recent entries last – surface tail
        const tailLen = 800;
        const slice = txt.length > tailLen ? txt.slice(-tailLen) : txt;
        parts.push("## Graphify Outcome Memory (LESSONS.md tail)\n" + slice);
      }
    } catch {}
  }

  // Latest reconcile if present
  try {
    if (fs.existsSync(reconcileDir)) {
      const files = fs.readdirSync(reconcileDir).filter(f => f.startsWith("reconcile-") && f.endsWith(".md")).sort().reverse();
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
      const bootstrap = getBootstrapText();
      if (!bootstrap || !output.messages || output.messages.length === 0)
        return;
      const firstUser = output.messages.find(
        (msg) => msg.info?.role === "user",
      );
      if (!firstUser || !firstUser.parts || firstUser.parts.length === 0)
        return;

      const alreadyInjected = firstUser.parts.some(
        (part) =>
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.includes(BOOTSTRAP_MARKER),
      );
      if (alreadyInjected) return;

      // Guard against prior bootstrap markers (avoid double-inject)
      const priorMarkers = [
        "NEXUS_BOOTSTRAP_V1",
        "NEXUS_BOOTSTRAP_V2",
        "NEXUS_BOOTSTRAP_V3",
      ];
      const alreadyPrior = firstUser.parts.some(
        (p) =>
          p.type === "text" &&
          typeof p.text === "string" &&
          priorMarkers.some((m) => p.text.includes(m)),
      );
      if (alreadyPrior) return;

      firstUser.parts.unshift({
        ...firstUser.parts[0],
        type: "text",
        text: bootstrap,
      });
    },

    "experimental.session.compacting": async (_input, output) => {
      if (!worktree) return;

      const activeRun = readRunStateSummary(worktree);
      // Compaction should not pull project-wide memory into unrelated chats.
      // Only an active, non-terminal run gets state and artifact context.
      if (!activeRun) return;

      const chunks = [];
      const liveContext = readContextFile(worktree);
      if (liveContext) {
        chunks.push("## Nexus Live Context\n" + liveContext.slice(0, 1200));
      }

      chunks.push(activeRun.text);

      chunks.push(
        [
          "## Nexus Active Artifact Pointers",
          "- plan: .opencode/plans/PLAN.md",
          "- graphify: graphify-out/",
          "- metrics: .opencode/runs/" + activeRun.state.run_id + "/metrics.jsonl",
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
