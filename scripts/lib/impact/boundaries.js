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

export function scopeExpansionNeeded(allowed_files, changed_files) {
  const allowed = new Set(normalizeAllowedFiles(allowed_files));
  if (allowed.size === 0) return { needed: false, extras: [] };
  const extras = [];
  for (const f of changed_files || []) {
    const p = typeof f === "string" ? f : f.path;
    if (!p) continue;
    const ok = [...allowed].some((a) => {
      if (a === "*" || a === p) return true;
      if (a.endsWith("/")) return p.startsWith(a);
      if (a.includes("*")) {
        const re = new RegExp(
          `^${a.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
        );
        return re.test(p);
      }
      return false;
    });
    if (!ok) extras.push(p);
  }
  return { needed: extras.length > 0, extras };
}
