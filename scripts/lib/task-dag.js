/**
 * Task dependency DAG + parallel scheduler.
 * Only independent tasks (no shared unresolved deps / file conflicts) run together.
 */
import { globsOverlap } from "./impact/boundaries.js";

export function buildTaskDag(tasks = []) {
  const byId = new Map();
  for (const t of tasks) {
    if (!t?.id) throw new Error("task missing id");
    byId.set(t.id, {
      id: t.id,
      depends_on: [...(t.depends_on || t.deps || [])],
      files: [...(t.files || t.allowed_files || [])],
      raw: t,
    });
  }
  for (const t of byId.values()) {
    for (const d of t.depends_on) {
      if (!byId.has(d)) throw new Error(`unknown dependency ${d} for task ${t.id}`);
    }
  }
  return { byId, tasks: [...byId.values()] };
}

export function detectCycle(dag) {
  const visiting = new Set();
  const done = new Set();
  function visit(id, stack = []) {
    if (done.has(id)) return null;
    if (visiting.has(id)) return [...stack, id];
    visiting.add(id);
    for (const d of dag.byId.get(id).depends_on) {
      const c = visit(d, [...stack, id]);
      if (c) return c;
    }
    visiting.delete(id);
    done.add(id);
    return null;
  }
  for (const id of dag.byId.keys()) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

function sharesFiles(a, b) {
  const filesA = a.files || [];
  const filesB = b.files || [];
  if (filesA.length === 0 || filesB.length === 0) return false;
  for (const fa of filesA) {
    for (const fb of filesB) {
      if (fa === fb || fa === "*" || fb === "*") return true;
      if (globsOverlap(fa, fb)) return true;
    }
  }
  return false;
}

/**
 * Ready tasks whose deps are in completed set and that don't file-conflict
 * with currently running tasks.
 */
export function readyTasks(dag, { completed = new Set(), running = [] } = {}) {
  const out = [];
  for (const t of dag.tasks) {
    if (completed.has(t.id)) continue;
    if (running.some((r) => r.id === t.id)) continue;
    if (!t.depends_on.every((d) => completed.has(d))) continue;
    if (running.some((r) => sharesFiles(t, r))) continue;
    out.push(t);
  }
  return out;
}

export function scheduleParallel(dag, { maxConcurrency = 2, completed = new Set() } = {}) {
  const cycle = detectCycle(dag);
  if (cycle) {
    return { ok: false, error: `dependency cycle: ${cycle.join(" → ")}` };
  }
  const waves = [];
  const done = new Set(completed);
  let guard = 0;
  while (done.size < dag.tasks.length && guard < dag.tasks.length + 2) {
    guard += 1;
    const ready = readyTasks(dag, { completed: done, running: [] });
    if (ready.length === 0) {
      return { ok: false, error: "no ready tasks — blocked DAG", done: [...done], waves };
    }
    const wave = ready.slice(0, Math.max(1, maxConcurrency));
    // Within a wave, drop file conflicts
    const selected = [];
    for (const t of wave) {
      if (selected.some((s) => sharesFiles(t, s))) continue;
      selected.push(t);
    }
    waves.push(selected.map((t) => t.id));
    for (const t of selected) done.add(t.id);
  }
  return { ok: true, waves, maxConcurrency };
}
