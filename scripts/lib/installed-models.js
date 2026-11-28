import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Model and wait-budget layers from the packaged defaults and the user's own
 * OpenCode config directory, merged in that order. A repository's
 * `.opencode/nexus.models.json` is not a layer: the agent can write into the
 * project, so a project file must not raise or remove a wait budget.
 *
 * @param {{ defaultFile?: string, configDir?: string }} [options]
 * @returns {Record<string, unknown>}
 */
export function readInstalledModels({ defaultFile, configDir } = {}) {
  const dir =
    configDir || process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode");
  const files = [defaultFile, path.join(dir, "nexus.models.json")].filter(Boolean);
  const merged = {};
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data && typeof data === "object" && !Array.isArray(data)) Object.assign(merged, data);
    } catch {
      // A missing or unreadable layer keeps the previous layers.
    }
  }
  return merged;
}
