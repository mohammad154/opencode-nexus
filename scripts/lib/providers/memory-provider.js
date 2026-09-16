/**
 * Memory provider — LESSONS / outcome memory under .opencode.
 */
import fs from "fs";
import path from "path";
import { validateContainedPath } from "../filesystem-boundary.js";

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
      ].filter((root) =>
        validateContainedPath(worktree, root, {
          allowMissing: true,
          rejectSymlinks: true,
        }).ok,
      );
      for (const root of roots) {
        const lessons = path.join(root, "LESSONS.md");
        const lessonsBoundary = validateContainedPath(worktree, lessons, {
          allowMissing: false,
          rejectSymlinks: true,
        });
        if (lessonsBoundary.ok && fs.existsSync(lessons)) {
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
              const candidate = path.join(root, file);
              const boundary = validateContainedPath(worktree, candidate, {
                allowMissing: false,
                rejectSymlinks: true,
              });
              if (!boundary.ok) continue;
              const txt = fs.readFileSync(candidate, "utf8");
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
      const boundary = validateContainedPath(worktree, dir, {
        allowMissing: true,
        rejectSymlinks: true,
      });
      if (!boundary.ok) {
        return {
          ok: false,
          error: `memory path violates filesystem boundary (${boundary.reason})`,
        };
      }
      fs.mkdirSync(dir, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
      const body =
        typeof entry === "string"
          ? entry
          : `# Outcome\n\n${entry.summary || ""}\n\n${entry.body || JSON.stringify(entry, null, 2)}\n`;
      const file = path.join(dir, name);
      const fileBoundary = validateContainedPath(worktree, file, {
        allowMissing: true,
        rejectSymlinks: true,
      });
      if (!fileBoundary.ok) {
        return {
          ok: false,
          error: `memory file violates filesystem boundary (${fileBoundary.reason})`,
        };
      }
      fs.writeFileSync(file, body);
      return { ok: true, path: file };
    },
  };
}
