/**
 * Wall-clock budgets and TIMED_OUT degradation for Nexus subagents.
 *
 * The plugin watchdog calls recordSubagentTimeout when a role exceeds its
 * budget. `nexus next` then skips a timed-out advisor, accepts sealed
 * verification after a timed-out reviewer, or redispatches an implementer once.
 */
import fs from "node:fs";
import path from "node:path";
import { protectedRunDir } from "./protected-state.js";

export const DEFAULT_ROLE_BUDGETS_MS = Object.freeze({
  "plan-advisor": 5 * 60 * 1000,
  reviewer: 10 * 60 * 1000,
  implementer: 20 * 60 * 1000,
});

export const DEFAULT_REVIEWER_STEPS = 24;

function timeoutFile(worktree, runId) {
  const dir = protectedRunDir(worktree, runId);
  return dir ? path.join(dir, "subagent-timeouts.json") : null;
}

export function roleBudgetMs(role, models = {}, env = process.env) {
  const envKey = `NEXUS_${String(role || "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()}_BUDGET_MS`;
  const fromEnv = Number(env?.[envKey]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const fromRole = Number(models?.[role]?.budget_ms ?? models?.[role]?.budgetMs);
  if (Number.isFinite(fromRole) && fromRole > 0) return fromRole;
  const fromTable = Number(models?.budgets?.[role]);
  if (Number.isFinite(fromTable) && fromTable > 0) return fromTable;
  return DEFAULT_ROLE_BUDGETS_MS[role] || null;
}

export function loadRoleBudgets(models = {}, env = process.env) {
  const budgets = {};
  for (const role of Object.keys(DEFAULT_ROLE_BUDGETS_MS)) {
    const budget = roleBudgetMs(role, models, env);
    if (budget) budgets[role] = budget;
  }
  return budgets;
}

export function normalizeSubagentRole(value) {
  const role = String(value ?? "")
    .trim()
    .toLowerCase();
  if (role === "plan-advisor" || role === "plan_advisor" || role === "planadvisor") {
    return "plan-advisor";
  }
  if (role === "reviewer" || role === "implementer") return role;
  return null;
}

export function subagentRoleFromTaskArgs(args = {}) {
  return normalizeSubagentRole(
    args.subagent_type ||
      args.subagentType ||
      args.agent ||
      args.type ||
      args.role ||
      "",
  );
}

function readTimeoutDocument(worktree, runId) {
  const file = timeoutFile(worktree, runId);
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    if (data.run_id !== runId) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Role-indexed timeouts for one run and, when set, one unit.
 * Records outside this run are ignored. There is no global timeout file.
 */
export function readSubagentTimeouts(worktree, runId, unit = null) {
  const document = readTimeoutDocument(worktree, runId);
  if (!document) return {};
  const records = document.records && typeof document.records === "object" ? document.records : {};
  const out = {};
  for (const record of Object.values(records)) {
    if (!record || record.status !== "TIMED_OUT" || record.run_id !== runId) continue;
    if (unit && record.unit !== unit) continue;
    const role = record.role;
    const previous = out[role];
    if (!previous || Number(record.attempts) >= Number(previous.attempts)) out[role] = record;
  }
  return out;
}

/**
 * Reviewer TIMED_OUT records for planned units, keyed by unit. The completion
 * gate decides whether each one is terminal; this reader only filters to this
 * run's records, so a forged or foreign file is never trusted by itself.
 */
export function readReviewerTimeouts(worktree, runId, units = []) {
  const out = {};
  for (const unit of units) {
    const record = readSubagentTimeouts(worktree, runId, unit).reviewer;
    if (record) out[unit] = record;
  }
  return out;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

/**
 * Persist a TIMED_OUT record and a handoff the orchestrator can read.
 * Attempts accumulate so an implementer is redispatched at most once.
 */
export function recordSubagentTimeout(worktree, event = {}) {
  if (!worktree) {
    throw new Error("subagent timeout requires a worktree");
  }
  const role = normalizeSubagentRole(event.role);
  if (!role) throw new Error(`unknown subagent role: ${event.role || "missing"}`);
  const runId = event.run_id || event.runId || null;
  const callID = event.callID || event.call_id || null;
  if (!runId) throw new Error("subagent timeout requires run_id");
  if (!callID) throw new Error("subagent timeout requires call_id");
  if (!timeoutFile(worktree, runId)) throw new Error(`subagent timeout run_id is not a valid run id: ${runId}`);
  const unit = String(event.unit || event.unit_id || "unit-1");
  const current = readTimeoutDocument(worktree, runId) || { run_id: runId, records: {} };
  const records = current.records && typeof current.records === "object" ? current.records : {};
  const key = `${unit}:${role}:${callID}`;
  if (records[key]?.status === "TIMED_OUT") {
    return { record: records[key], duplicate: true };
  }
  const attempts =
    Object.values(records).filter((record) => record?.role === role && record?.unit === unit).length +
    1;
  const record = {
    status: "TIMED_OUT",
    role,
    run_id: runId,
    unit,
    attempts,
    exhausted: role === "implementer" ? attempts >= 2 : attempts >= 2 && role === "reviewer",
    budget_ms: Number(event.budgetMs ?? event.budget_ms) || null,
    elapsed_ms: Number(event.elapsedMs ?? event.elapsed_ms ?? event.budgetMs) || null,
    at: new Date().toISOString(),
    call_id: callID,
  };
  records[key] = record;
  writeJsonAtomic(timeoutFile(worktree, runId), { run_id: runId, records });
  return { record };
}

function verificationPassed(state = {}) {
  const status = state.verification?.status || state.verification_status;
  return status === "PASSED";
}

/**
 * What `nexus next` should do after a recorded timeout.
 * Advisor: skip. Reviewer with sealed PASS: accept it. Implementer: one smaller retry.
 */
export function degradeSubagentTimeout(role, record, state = {}) {
  const normalized = normalizeSubagentRole(role);
  if (!record || record.status !== "TIMED_OUT" || !normalized) return null;
  const attempts = Number(record.attempts) || 1;
  if (normalized === "plan-advisor") {
    return {
      action: "skip_advisor",
      agent: null,
      instruction:
        "plan-advisor timed out. Skip it and continue. Do not dispatch it again.",
    };
  }
  if (normalized === "reviewer") {
    if (verificationPassed(state)) {
      return {
        action: "advance_to_final_verifying",
        agent: null,
        instruction:
          "reviewer timed out. Task verification stands, but final verification is still required. Do not mark the run COMPLETED and do not dispatch the reviewer again.",
      };
    }
    if (attempts < 2 && record.exhausted !== true) {
      return {
        action: "redispatch_once",
        agent: "reviewer",
        instruction:
          "reviewer timed out before verification was sealed. Re-dispatch it once with a smaller brief, then stop if it times out again.",
      };
    }
    return {
      action: "block_for_subagent_timeout",
      agent: null,
      instruction:
        "reviewer timed out and verification is not sealed. Do not dispatch it again.",
    };
  }
  if (normalized === "implementer") {
    if (attempts < 2 && record.exhausted !== true) {
      return {
        action: "redispatch_once",
        agent: "implementer",
        instruction:
          "implementer timed out. Re-dispatch it once with a smaller brief covering only the remaining acceptance criteria. Do not open a second retry.",
      };
    }
    return {
      action: "block_for_subagent_timeout",
      agent: null,
      instruction:
        "implementer timed out twice. Do not dispatch it again; reconcile the partial edit.",
    };
  }
  return null;
}

/**
 * In-process watchdog. Timers are injected so tests do not wait on the wall clock.
 */
function timeoutPayload(record, now) {
  return {
    role: record.role,
    callID: record.callID,
    budgetMs: record.budgetMs,
    elapsedMs: Math.max(0, now() - record.startedAt),
    parentSessionID: record.parentSessionID,
    childSessionID:
      record.child && record.child !== record.parentSessionID ? record.child : null,
    args: record.args,
  };
}

export function createSubagentWatchdog({
  budgets = DEFAULT_ROLE_BUDGETS_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
  now = () => Date.now(),
  onTimeout = () => {},
  abortChild = async () => ({ aborted: false }),
} = {}) {
  const inflight = new Map();
  const pendingByParent = new Map();
  function forget(callID, parentSessionID) {
    inflight.delete(callID);
    const queue = pendingByParent.get(parentSessionID);
    if (!queue) return;
    const next = queue.filter((id) => id !== callID);
    if (next.length === 0) pendingByParent.delete(parentSessionID);
    else pendingByParent.set(parentSessionID, next);
  }
  function recordTimeout(record) {
    if (record.recorded) return;
    record.recorded = true;
    try {
      onTimeout(timeoutPayload(record, now));
    } catch {
      // A timeout must not crash the host. The call is still settled.
    }
  }
  return {
    noteChildSession(parentSessionID, childSessionID) {
      if (!parentSessionID || !childSessionID || parentSessionID === childSessionID) return;
      const queue = pendingByParent.get(parentSessionID) || [];
      const callID = queue.find((id) => {
        const record = inflight.get(id);
        return record && !record.child;
      });
      if (!callID) return;
      inflight.get(callID).child = childSessionID;
    },
    childSession(callID) {
      return inflight.get(callID)?.child || null;
    },
    before(input = {}, output = {}) {
      const tool = input.tool || input.name;
      if (tool !== "task") return null;
      const args = output.args || input.args || {};
      const role = subagentRoleFromTaskArgs(args);
      const budgetMs = role ? budgets[role] : null;
      const callID = input.callID || input.callId || null;
      if (!role || !budgetMs || !callID) return null;
      const parentSessionID = input.sessionID || input.sessionId || null;
      const startedAt = now();
      const record = {
        role,
        callID,
        budgetMs,
        parentSessionID,
        args,
        startedAt,
        child: args.sessionID || args.session_id || null,
        timer: null,
        timedOut: false,
        recorded: false,
        recordOnReturn: false,
      };
      record.timer = schedule(() => {
        const current = inflight.get(callID);
        if (!current || current.timedOut || current.recorded) return;
        current.timedOut = true;
        const child = current.child;
        if (!child || child === current.parentSessionID) {
          current.recordOnReturn = true;
          return;
        }
        void (async () => {
          let aborted = false;
          try {
            const result = await abortChild(child);
            aborted = result?.aborted === true;
          } catch {
            aborted = false;
          }
          if (aborted) recordTimeout(current);
          else if (inflight.has(callID)) current.recordOnReturn = true;
          else if (!current.recorded) recordTimeout(current);
        })();
      }, budgetMs);
      inflight.set(callID, record);
      if (parentSessionID) {
        const queue = pendingByParent.get(parentSessionID) || [];
        queue.push(callID);
        pendingByParent.set(parentSessionID, queue);
      }
      return { callID, role, budgetMs };
    },
    after(input = {}) {
      const callID = input.callID || input.callId;
      if (!callID || !inflight.has(callID)) return false;
      const record = inflight.get(callID);
      cancel(record.timer);
      const timedOut = record.timedOut === true;
      if (timedOut && record.recordOnReturn && !record.recorded) recordTimeout(record);
      forget(callID, record.parentSessionID);
      return !timedOut;
    },
  };
}

export async function abortSubagentSession(client, sessionID) {
  if (!sessionID) return { aborted: false, reason: "no-session" };
  const abort = client?.session?.abort;
  if (typeof abort !== "function") return { aborted: false, reason: "no-abort-api" };
  try {
    await abort.call(client.session, { path: { id: sessionID } });
    return { aborted: true, sessionID };
  } catch (error) {
    return { aborted: false, reason: error?.message || String(error), sessionID };
  }
}
