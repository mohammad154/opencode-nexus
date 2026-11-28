/**
 * Wall-clock budgets and TIMED_OUT degradation for Nexus subagents.
 *
 * The plugin watchdog calls recordSubagentTimeout when a role exceeds its
 * budget. `nexus next` then skips a timed-out advisor, accepts sealed
 * verification after a timed-out reviewer, or redispatches an implementer once.
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_ROLE_BUDGETS_MS = Object.freeze({
  "plan-advisor": 5 * 60 * 1000,
  reviewer: 10 * 60 * 1000,
  implementer: 20 * 60 * 1000,
});

export const DEFAULT_REVIEWER_STEPS = 24;

const TIMEOUT_FILE = path.join(".opencode", "subagent-timeouts.json");

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

function timeoutPath(worktree) {
  return path.join(worktree, TIMEOUT_FILE);
}

export function readSubagentTimeouts(worktree) {
  if (!worktree) return {};
  try {
    const data = JSON.parse(fs.readFileSync(timeoutPath(worktree), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
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
  const current = readSubagentTimeouts(worktree);
  const previous = current[role] && typeof current[role] === "object" ? current[role] : {};
  const attempts = (Number(previous.attempts) || 0) + 1;
  const record = {
    status: "TIMED_OUT",
    role,
    attempts,
    exhausted: role === "implementer" ? attempts >= 2 : false,
    budget_ms: Number(event.budgetMs ?? event.budget_ms) || null,
    elapsed_ms: Number(event.elapsedMs ?? event.elapsed_ms ?? event.budgetMs) || null,
    at: new Date().toISOString(),
    call_id: event.callID || event.call_id || null,
  };
  current[role] = record;
  writeJsonAtomic(timeoutPath(worktree), current);

  const handoff = {
    schema_version: "1.0",
    agent: role,
    status: "TIMED_OUT",
    verdict: "TIMED_OUT",
    run_id: event.run_id || null,
    created_at: record.at,
    read_only: role !== "implementer",
    wrote_production_code: false,
    budget_ms: record.budget_ms,
    elapsed_ms: record.elapsed_ms,
    attempts,
  };
  const handoffFile = path.join(
    worktree,
    ".opencode",
    "handoffs",
    `${role}-timeout.json`,
  );
  writeJsonAtomic(handoffFile, handoff);
  return { record, handoff, handoff_path: handoffFile };
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
        action: "accept_sealed_verification",
        agent: null,
        instruction:
          "reviewer timed out. Accept the sealed verification and continue. Do not dispatch the reviewer again.",
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
export function createSubagentWatchdog({
  budgets = DEFAULT_ROLE_BUDGETS_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
  now = () => Date.now(),
  onTimeout = () => {},
} = {}) {
  const inflight = new Map();
  const children = new Map();
  return {
    noteChildSession(parentSessionID, childSessionID) {
      if (parentSessionID && childSessionID && parentSessionID !== childSessionID) {
        children.set(parentSessionID, childSessionID);
      }
    },
    childSession(parentSessionID) {
      return children.get(parentSessionID) || null;
    },
    before(input = {}, output = {}) {
      const tool = input.tool || input.name;
      if (tool !== "task") return null;
      const args = output.args || input.args || {};
      const role = subagentRoleFromTaskArgs(args);
      const budgetMs = role ? budgets[role] : null;
      if (!role || !budgetMs) return null;
      const callID =
        input.callID || input.callId || `${role}:${now()}:${inflight.size}`;
      const parentSessionID = input.sessionID || input.sessionId || null;
      const startedAt = now();
      const timer = schedule(() => {
        const record = inflight.get(callID);
        if (!record || record.settled) return;
        record.settled = true;
        inflight.delete(callID);
        const childSessionID =
          args.sessionID ||
          args.session_id ||
          (parentSessionID ? children.get(parentSessionID) : null) ||
          null;
        onTimeout({
          role,
          callID,
          budgetMs,
          elapsedMs: Math.max(0, now() - startedAt),
          parentSessionID,
          childSessionID:
            childSessionID && childSessionID !== parentSessionID ? childSessionID : null,
          args,
        });
      }, budgetMs);
      inflight.set(callID, { role, timer, startedAt, settled: false });
      return { callID, role, budgetMs };
    },
    after(input = {}) {
      const callID = input.callID || input.callId;
      if (!callID || !inflight.has(callID)) return false;
      const record = inflight.get(callID);
      record.settled = true;
      cancel(record.timer);
      inflight.delete(callID);
      return true;
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
