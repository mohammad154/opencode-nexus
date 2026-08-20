/**
 * Scope / boundary helpers for impact + scope lock.
 */
export function normalizeAllowedFiles(files = []) {
  return [...new Set(
    (files || [])
      .map((f) => String(f || "").replace(/\\/g, "/").replace(/^\.\//, ""))
      .filter(Boolean),
  )];
}

export function globToRegExp(glob) {
  const normalized = String(glob || "").replace(/\\/g, "/");
  if (normalized === "*") return /^.*$/;
  const escaped = normalized
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export function pathMatchesGlob(path, glob) {
  const p = String(path || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const g = String(glob || "").replace(/\\/g, "/");
  if (!p || !g) return false;
  if (g === "*" || g === p) return true;
  if (g.endsWith("/") && p.startsWith(g)) return true;
  if (g.includes("*")) return globToRegExp(g).test(p);
  return g === p;
}

export function globsOverlap(a, b) {
  if (!a || !b) return false;
  if (a === "*" || b === "*") return true;
  if (pathMatchesGlob(a, b) || pathMatchesGlob(b, a)) return true;
  if (a.endsWith("/") && b.startsWith(a)) return true;
  if (b.endsWith("/") && a.startsWith(b)) return true;
  return false;
}

export function scopeExpansionNeeded(allowed_files, changed_files) {
  const allowed = new Set(normalizeAllowedFiles(allowed_files));
  if (allowed.size === 0) return { needed: false, extras: [] };
  const extras = [];
  for (const f of changed_files || []) {
    const p = typeof f === "string" ? f : f.path;
    if (!p) continue;
    const ok = [...allowed].some((a) => pathMatchesGlob(p, a));
    if (!ok) extras.push(p);
  }
  return { needed: extras.length > 0, extras };
}
