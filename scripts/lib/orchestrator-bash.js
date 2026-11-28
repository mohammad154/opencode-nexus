/**
 * Orchestrator bash policy, enforced in the plugin before OpenCode's own
 * permission rules see the command.
 *
 * The command is tokenized as a POSIX-like word list and every segment must
 * match an exact read-only form or a named workflow form. Anything the
 * tokenizer cannot model (command substitution, backticks, unquoted
 * redirection, subshells, newlines, env assignments, unknown commands) is
 * denied. The decision for each segment is `allow`, `ask`, or `deny`; the
 * whole command gets the strictest of them.
 */
import fs from "node:fs";
import path from "node:path";

const DENY = (reason) => ({ ok: false, action: "deny", reason });

function tokenize(command) {
  const text = String(command ?? "");
  if (/[\r\n]/.test(text)) return { ok: false, reason: "bash command cannot span lines" };
  if (text.includes("`") || text.includes("$(")) {
    return { ok: false, reason: "bash command substitution is not allowed" };
  }
  const segments = [];
  let tokens = [];
  let word = null;
  let quote = null;
  const flushWord = () => {
    if (word !== null) tokens.push(word);
    word = null;
  };
  const flushSegment = (separator) => {
    flushWord();
    if (tokens.length === 0) return false;
    segments.push({ tokens, separator });
    tokens = [];
    return true;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && (next === '"' || next === "\\")) {
        word += next;
        index += 1;
      } else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      word = word ?? "";
      continue;
    }
    if (char === "\\") {
      if (next === undefined) return { ok: false, reason: "bash command ends with a backslash" };
      word = (word ?? "") + next;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      flushWord();
      continue;
    }
    if (char === ";" || char === "&" || char === "|") {
      const doubled = (char === "&" || char === "|") && next === char;
      if (doubled) index += 1;
      if (!flushSegment(doubled ? char + char : char)) {
        return { ok: false, reason: "bash command has an empty segment" };
      }
      continue;
    }
    if (char === "<" || char === ">" || char === "(" || char === ")") {
      return { ok: false, reason: "bash redirection and subshells are not allowed" };
    }
    word = (word ?? "") + char;
  }
  if (quote) return { ok: false, reason: "bash command has an unterminated quote" };
  if (!flushSegment(null) && segments.length > 0) {
    return { ok: false, reason: "bash command has an empty segment" };
  }
  if (segments.length === 0) return { ok: false, reason: "bash command is missing" };
  return { ok: true, segments };
}

const FIND_WRITE_OR_EXEC = /^(-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprint0|-fprintf|-fls)$/;

function assessGit(tokens, options) {
  const sub = tokens[1];
  if (!sub) return DENY("git needs a subcommand");
  if (sub.startsWith("-")) {
    return DENY("git options before the subcommand (-c, -C, --git-dir) are not allowed");
  }
  const args = tokens.slice(2);
  const flags = args.filter((arg) => arg.startsWith("-"));
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  switch (sub) {
    case "status":
    case "rev-parse":
      return { ok: true, action: "allow" };
    case "log":
    case "show":
    case "diff":
      if (args.some((arg) => /^--(output|ext-diff|textconv)/.test(arg))) {
        return DENY("git --output, --ext-diff and --textconv write files or run external programs");
      }
      return { ok: true, action: "allow" };
    case "symbolic-ref": {
      if (args.some((arg) => /^-[^-]*[dm]/.test(arg) || /^--delete/.test(arg))) {
        return DENY("git symbolic-ref may not change refs");
      }
      if (positionals.length !== 1) return DENY("git symbolic-ref may only read one ref");
      return { ok: true, action: "allow" };
    }
    case "worktree": {
      const verb = args[0];
      if (verb === "list") return { ok: true, action: "allow" };
      if (["add", "remove", "prune", "move", "repair", "lock", "unlock"].includes(verb)) {
        return { ok: true, action: "ask", reason: `git worktree ${verb} changes the lane layout` };
      }
      return DENY("git worktree supports only list and nexus lane commands");
    }
    case "branch": {
      if (flags.some((arg) => /^-[^-]*[dDmMcCf]/.test(arg) || /^--(delete|move|copy|force)/.test(arg))) {
        return DENY("branch deletion, rename, copy and force are performed by nexus-branch-cleanup");
      }
      if (flags.some((arg) => /^-[^-]*u/.test(arg) || /^--(set-upstream-to|unset-upstream|edit-description)/.test(arg))) {
        return { ok: true, action: "ask", reason: "branch upstream changes need approval" };
      }
      const listing = flags.some((arg) => /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)/.test(arg));
      if (positionals.length > 0 && !listing) return DENY("branch creation is done with git checkout -b");
      return { ok: true, action: "allow" };
    }
    case "checkout": {
      if (args.some((arg) => /^-[^-]*[fB]/.test(arg) || /^--(force|orphan|overwrite-ignore)/.test(arg))) {
        return DENY("git checkout -f and -B discard work or reset branches");
      }
      if (args.includes("--") || args.some((arg) => /^-[^-]*p/.test(arg) || arg === "--patch")) {
        return { ok: true, action: "ask", reason: "git checkout that restores paths discards changes" };
      }
      if (!args.includes("-b") && positionals.length === 1 && positionals[0] !== "-") {
        if (options.worktree && pathExistsInWorktree(options.worktree, positionals[0])) {
          return { ok: true, action: "ask", reason: "git checkout of a path discards changes" };
        }
        if (!options.worktree) {
          return { ok: true, action: "ask", reason: "git checkout target cannot be verified" };
        }
      }
      return { ok: true, action: "allow" };
    }
    case "merge":
      return { ok: true, action: "allow" };
    case "push":
    case "reset":
    case "clean":
      return { ok: true, action: "ask", reason: `git ${sub} needs approval` };
    default:
      return DENY(`git ${sub} is not in the orchestrator allowlist`);
  }
}

function pathExistsInWorktree(worktree, name) {
  try {
    return fs.existsSync(path.join(worktree, name));
  } catch {
    return true;
  }
}

function assessNpm(tokens) {
  if (tokens[1] === "test") return { ok: true, action: "allow" };
  if (tokens[1] === "run" && /^(test|build)/.test(tokens[2] || "")) {
    return { ok: true, action: "allow" };
  }
  return DENY("npm is limited to test and build scripts");
}

function assessSegment(tokens, options) {
  const [name, ...args] = tokens;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) {
    return DENY("environment assignments before a command are not allowed");
  }
  switch (name) {
    case "nexus":
    case "ls":
    case "cat":
    case "head":
    case "wc":
      return { ok: true, action: "allow" };
    case "rg":
    case "grep":
      if (args.some((arg) => arg.startsWith("--pre"))) {
        return DENY("rg --pre and --pre-glob run an external program");
      }
      return { ok: true, action: "allow" };
    case "find":
      if (tokens.some((arg) => FIND_WRITE_OR_EXEC.test(arg) || /^-(exec|ok|fprint|fls)/.test(arg))) {
        return DENY("find -delete, -exec, -ok and -fprint write or run commands");
      }
      return { ok: true, action: "allow" };
    case "git":
      return assessGit(tokens, options);
    case "npm":
      return assessNpm(tokens);
    case "python3":
      if (tokens.length === 2 && tokens[1] === "--version") return { ok: true, action: "allow" };
      return DENY("python3 is limited to --version");
    case "bash":
      if (tokens[1] !== "scripts/nexus-branch-cleanup.sh") {
        return DENY("bash is limited to scripts/nexus-branch-cleanup.sh");
      }
      if (args.some((arg) => arg.includes("--force-discard"))) {
        return { ok: true, action: "ask", reason: "force-discard needs approval" };
      }
      return { ok: true, action: "allow" };
    default:
      return DENY(`${name || "command"} is not in the orchestrator bash allowlist`);
  }
}

const RANK = { allow: 0, ask: 1, deny: 2 };

/**
 * @param {string} command
 * @param {{ worktree?: string }} [options] worktree enables path checks for
 *   `git checkout <name>`; without it such checkouts ask.
 * @returns {{ ok: boolean, action: "allow"|"ask"|"deny", reason?: string }}
 */
export function assessOrchestratorBash(command, options = {}) {
  const parsed = tokenize(command);
  if (!parsed.ok) return DENY(parsed.reason);
  let verdict = { ok: true, action: "allow" };
  for (const segment of parsed.segments) {
    const result = assessSegment(segment.tokens, options);
    if (RANK[result.action] > RANK[verdict.action]) verdict = result;
    if (verdict.action === "deny") return verdict;
  }
  return verdict;
}
