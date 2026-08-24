/**
 * Memory provider — LESSONS / outcome memory under .opencode.
 */
import fs from "fs";
import path from "path";

export function createMemoryProvider() {
  return {
    mode: "nexus-memory",
    supported: true,
    capability: "outcome-memory",
    retrieve(worktree, _query = {}) {
      const entries = [];
      const tailLen = 2500;
      const roots = [
        path.join(worktree, ".opencode", "memory"),
        path.join(worktree, ".opencode", "reflections"),
      ];
      for (const root of roots) {
        const lessons = path.join(root, "LESSONS.md");
        if (fs.existsSync(lessons)) {
          const txt = fs.readFileSync(lessons, "utf8");
          entries.push(txt.length > tailLen ? txt.slice(-tailLen) : txt);
        }
        if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
          const files = fs
            .readdirSync(root)
            .filter((f) => f.endsWith(".md") && f !== "LESSONS.md")
            .sort()
            .reverse()
            .slice(0, 3);
          for (const file of files) {
            try {
              const txt = fs.readFileSync(path.join(root, file), "utf8");
              entries.push(txt.length > tailLen ? txt.slice(-tailLen) : txt);
            } catch {
              /* optional */
            }
          }
        }
      }
      return {
        entries,
        source: entries.length > 0 ? "opencode-memory" : "none",
      };
    },
    record(worktree, entry = {}) {
      const dir = path.join(worktree, ".opencode", "memory");
      fs.mkdirSync(dir, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
      const body =
        typeof entry === "string"
          ? entry
          : `# Outcome\n\n${entry.summary || ""}\n\n${entry.body || JSON.stringify(entry, null, 2)}\n`;
      const file = path.join(dir, name);
      fs.writeFileSync(file, body);
      return { ok: true, path: file };
    },
  };
}
