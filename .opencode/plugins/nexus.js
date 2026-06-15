import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(__dirname, "../../skills");

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
const BOOTSTRAP_MARKER = "NEXUS_BOOTSTRAP_V1";

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
- \`Task\` subagents → @implementer, @spec-reviewer, @code-reviewer
- \`TodoWrite\` → \`todowrite\`

Use OpenCode's native \`skill\` tool to load Nexus skills automatically based on task phase.`;

  bootstrapCache = [
    "<EXTREMELY_IMPORTANT>",
    BOOTSTRAP_MARKER,
    "You have OpenCode Nexus workflow support.",
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

function summarizePlan(planText) {
  const lines = planText.split("\n").map((line) => line.trim());
  const bullets = [];
  for (const line of lines) {
    if (
      line.startsWith("- [ ]") ||
      line.startsWith("- [x]") ||
      line.startsWith("## ")
    ) {
      bullets.push(line);
    }
    if (bullets.length >= 15) break;
  }
  return bullets.length > 0 ? bullets.join("\n") : planText.slice(0, 1200);
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

      if (chunks.length > 0) {
        output.context.push(chunks.join("\n\n"));
      }
    },
  };
};
