import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(__dirname, "../../skills");

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
const BOOTSTRAP_MARKER = "NEXUS_BOOTSTRAP_V3";

let bootstrapCache;

function stripFrontmatter(content) {
  return content.replace(FRONTMATTER_RE, "");
}

function getBootstrapText() {
  if (bootstrapCache !== undefined) return bootstrapCache;
  const skillPath = path.join(skillsDir, "using-nexus", "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    bootstrapCache = null;
    return null;
  }

  const raw = fs.readFileSync(skillPath, "utf8");
  const body = stripFrontmatter(raw).trim();

  const toolMapping = `**Tool Mapping for OpenCode:**
- \`Skill\` tool → OpenCode \`skill\` tool
- \`Task\` / Agent subagents (canonical) → implementer, unified-reviewer, spec-reviewer, code-reviewer, blast-analyzer, knowledge-graph, reconciler
- Prefixed installs (Claude/Cursor/AG) → nexus-<canonical> (see skills/orchestrating/dispatch.md)
- Review is **profile-aware** (default balanced): unified-reviewer OR dual (spec then code) OR skip (docs-only fast). High-risk always dual. See profiles.md + dispatch.md.
- Prefer scripts for graph/blast/cleanup/cost estimate — do not LLM-dispatch for those.
- Codex/Gemini (skills-only): isolated reviewer turns still write the same handoff JSON gates
- \`TodoWrite\` → \`todowrite\`

**Cross-pollinated capabilities (V3):**
- \`workflow profiles\` – fast | balanced (default) | strict — see config/workflow-profiles.json
- \`knowledge-graph\` – scripts/nexus-graph.sh with commit cache (generated_at_commit)
- \`blast-radius\` – scripts/nexus-blast.js per task (strict) or execution unit (fast/balanced)
- \`unified-reviewer\` – combined spec+quality for low/medium risk
- \`reconcile\` – verifies DONE still holds, investigates BLOCKED, refreshes drift
- \`outcome-memory\` – LESSONS.md with noteworthy-only (fast/balanced) or every-task (strict)
- \`writing-plans\` – improve-grade: file:line evidence, effort/confidence, STOP, drift SHA, verification gates
- \`orchestrating\` – profile-aware batching, script cleanup via nexus-branch-cleanup.sh, cost estimate
- Multi-platform installer: \`install.sh --only claude,cursor,codex,gemini,opencode,antigravity\`
- Optional graph refresh: \`scripts/install-git-hook.sh\` (post-commit) in a consumer repo

Use OpenCode's native \`skill\` tool to load Nexus skills automatically based on task phase.`;

  bootstrapCache = [
    "<EXTREMELY_IMPORTANT>",
    BOOTSTRAP_MARKER,
    "You have OpenCode Nexus V3 workflow support (profiles + scripts-first).",
    "The using-nexus skill content below is already loaded; do not load it again.",
    "",
    body,
    "",
    toolMapping,
    "</EXTREMELY_IMPORTANT>",
  ].join("\n");

  return bootstrapCache;
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

function readKnowledgeSummary(worktree) {
  const gMd = path.join(worktree, ".opencode", "knowledge", "graph.md");
  const lessons = path.join(worktree, ".opencode", "knowledge", "LESSONS.md");
  const reconcileDir = path.join(worktree, ".opencode", "knowledge");
  const parts = [];

  if (fs.existsSync(gMd)) {
    try {
      const txt = fs.readFileSync(gMd, "utf8").trim();
      parts.push("## Nexus Knowledge Graph\n" + txt.slice(0, 1500));
    } catch {}
  }

  if (fs.existsSync(lessons)) {
    try {
      const txt = fs.readFileSync(lessons, "utf8").trim();
      if (txt.length > 0) {
        // Recent entries last – surface tail
        const tailLen = 2500;
        const slice = txt.length > tailLen ? txt.slice(-tailLen) : txt;
        parts.push("## Nexus Outcome Memory (LESSONS.md tail)\n" + slice);
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
        parts.push("## Nexus Last Reconcile\n" + txt.slice(0, 1200));
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
    if (bullets.length >= 25) break;
  }
  return bullets.length > 0 ? bullets.join("\n") : planText.slice(0, 1600);
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
      const priorMarkers = ["NEXUS_BOOTSTRAP_V1", "NEXUS_BOOTSTRAP_V2"];
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

      const chunks = [];
      const liveContext = readContextFile(worktree);
      if (liveContext) {
        chunks.push("## Nexus Live Context\n" + liveContext);
      }

      const plan = readPlanFile(worktree);
      if (plan) {
        chunks.push("## Nexus Plan Snapshot\n" + summarizePlan(plan));
      }

      const knowledge = readKnowledgeSummary(worktree);
      if (knowledge) {
        chunks.push(knowledge);
      }

      if (chunks.length > 0) {
        output.context.push(chunks.join("\n\n"));
      }
    },
  };
};
