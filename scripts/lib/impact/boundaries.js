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

function tokenizeSegment(s) {
  const chars = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "*") {
      if (chars[chars.length - 1] !== "*") chars.push("*");
    } else {
      chars.push(s[i]);
    }
  }
  return chars;
}

function segmentPatternOverlaps(segA, segB) {
  if (segA === segB) return true;
  if (segA === "*" || segB === "*") return true;
  if (!segA.includes("*") && !segB.includes("*")) return segA === segB;
  if (!segA.includes("*")) {
    const reB = new RegExp(
      "^" +
        segB
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "$",
    );
    return reB.test(segA);
  }
  if (!segB.includes("*")) {
    const reA = new RegExp(
      "^" +
        segA
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "$",
    );
    return reA.test(segB);
  }

  const tokA = tokenizeSegment(segA);
  const tokB = tokenizeSegment(segB);
  const lenA = tokA.length;
  const lenB = tokB.length;

  function epsClosureA(states) {
    const set = new Set(states);
    let changed = true;
    while (changed) {
      changed = false;
      for (const st of set) {
        if (st < lenA && tokA[st] === "*" && !set.has(st + 1)) {
          set.add(st + 1);
          changed = true;
        }
      }
    }
    return set;
  }

  function epsClosureB(states) {
    const set = new Set(states);
    let changed = true;
    while (changed) {
      changed = false;
      for (const st of set) {
        if (st < lenB && tokB[st] === "*" && !set.has(st + 1)) {
          set.add(st + 1);
          changed = true;
        }
      }
    }
    return set;
  }

  const alphabet = new Set();
  for (const c of tokA) if (c !== "*") alphabet.add(c);
  for (const c of tokB) if (c !== "*") alphabet.add(c);
  let generic = "\0";
  while (alphabet.has(generic)) {
    generic = String.fromCharCode(generic.charCodeAt(0) + 1);
  }
  alphabet.add(generic);

  const visited = new Set();
  const queue = [];

  const startA = epsClosureA([0]);
  const startB = epsClosureB([0]);
  for (const a of startA) {
    for (const b of startB) {
      const k = `${a},${b}`;
      if (!visited.has(k)) {
        visited.add(k);
        queue.push([a, b]);
      }
    }
  }

  while (queue.length > 0) {
    const [u, v] = queue.shift();
    if (u === lenA && v === lenB) return true;

    for (const ch of alphabet) {
      const nextA = [];
      if (u < lenA) {
        if (tokA[u] === "*") nextA.push(u);
        if (tokA[u] === ch) nextA.push(u + 1);
      }
      if (nextA.length === 0) continue;

      const nextB = [];
      if (v < lenB) {
        if (tokB[v] === "*") nextB.push(v);
        if (tokB[v] === ch) nextB.push(v + 1);
      }
      if (nextB.length === 0) continue;

      const closedA = epsClosureA(nextA);
      const closedB = epsClosureB(nextB);

      for (const na of closedA) {
        for (const nb of closedB) {
          const k = `${na},${nb}`;
          if (!visited.has(k)) {
            visited.add(k);
            queue.push([na, nb]);
          }
        }
      }
    }
  }
  return false;
}

function parseGlobSegments(glob) {
  let s = String(glob || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!s) return [];
  if (s === "*" || s === "**") return ["**"];
  if (s.endsWith("/")) {
    s = s.slice(0, -1) + "/**";
  }
  const raw = s.split("/").filter(Boolean);
  const result = [];
  for (const part of raw) {
    if (part === "**" && result[result.length - 1] === "**") continue;
    result.push(part);
  }
  return result;
}

export function globsOverlap(a, b) {
  if (!a || !b) return false;
  const strA = String(a).replace(/\\/g, "/").replace(/^\.\//, "").trim();
  const strB = String(b).replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!strA || !strB) return false;
  if (strA === strB) return true;
  if (strA === "*" || strB === "*" || strA === "**" || strB === "**") return true;

  // Prefix matching fast paths
  if (strA.endsWith("/") && strB.startsWith(strA)) return true;
  if (strB.endsWith("/") && strA.startsWith(strB)) return true;

  const segsA = parseGlobSegments(strA);
  const segsB = parseGlobSegments(strB);

  if (segsA.length === 0 || segsB.length === 0) return false;

  const M = segsA.length;
  const N = segsB.length;

  const visited = new Set();
  const queue = [[0, 0]];
  visited.add("0,0");

  while (queue.length > 0) {
    const [i, j] = queue.shift();
    if (i === M && j === N) return true;

    if (i < M && segsA[i] === "**") {
      const k0 = `${i + 1},${j}`;
      if (!visited.has(k0)) {
        visited.add(k0);
        queue.push([i + 1, j]);
      }
      if (j < N) {
        const k1 = `${i},${j + 1}`;
        if (!visited.has(k1)) {
          visited.add(k1);
          queue.push([i, j + 1]);
        }
        const k2 = `${i + 1},${j + 1}`;
        if (!visited.has(k2)) {
          visited.add(k2);
          queue.push([i + 1, j + 1]);
        }
      }
    } else if (j < N && segsB[j] === "**") {
      const k0 = `${i},${j + 1}`;
      if (!visited.has(k0)) {
        visited.add(k0);
        queue.push([i, j + 1]);
      }
      if (i < M) {
        const k1 = `${i + 1},${j}`;
        if (!visited.has(k1)) {
          visited.add(k1);
          queue.push([i + 1, j]);
        }
        const k2 = `${i + 1},${j + 1}`;
        if (!visited.has(k2)) {
          visited.add(k2);
          queue.push([i + 1, j + 1]);
        }
      }
    } else if (i < M && j < N) {
      if (segmentPatternOverlaps(segsA[i], segsB[j])) {
        const k = `${i + 1},${j + 1}`;
        if (!visited.has(k)) {
          visited.add(k);
          queue.push([i + 1, j + 1]);
        }
      }
    } else if (i === M && j < N) {
      if (segsB[j] === "**") {
        const k = `${i},${j + 1}`;
        if (!visited.has(k)) {
          visited.add(k);
          queue.push([i, j + 1]);
        }
      }
    } else if (j === N && i < M) {
      if (segsA[i] === "**") {
        const k = `${i + 1},${j}`;
        if (!visited.has(k)) {
          visited.add(k);
          queue.push([i + 1, j]);
        }
      }
    }
  }

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
