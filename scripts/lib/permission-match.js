/**
 * OpenCode-style permission globs.
 *
 * OpenCode matches edit and bash rules against the absolute path or the full
 * command string. A pattern such as `.opencode/**` therefore never matches
 * `/app/.opencode/plans/PLAN.md`. `*` becomes "any characters" (including
 * slashes) and the last matching rule wins, which is the host's rule order.
 * Backslashes are normalized so Windows and WSL paths use the same patterns.
 */

export function normalizePermissionPath(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
}

/**
 * @param {string} pattern
 * @returns {RegExp}
 */
export function permissionPatternToRegExp(pattern) {
  const normalized = normalizePermissionPath(pattern);
  if (normalized === "*") return /^[\s\S]*$/;
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      source += ".*";
      if (normalized[index + 1] === "*") index += 1;
      continue;
    }
    if ("\\^$+?.()|[]{}".includes(char)) source += `\\${char}`;
    else source += char;
  }
  return new RegExp(`^${source}$`);
}

export function permissionPatternMatches(pattern, value) {
  return permissionPatternToRegExp(pattern).test(normalizePermissionPath(value));
}

/**
 * Last matching rule wins. No match yields `ask` (OpenCode's default).
 *
 * @param {Record<string, string>|null|undefined} rules
 * @param {string} value
 * @returns {"allow"|"deny"|"ask"}
 */
export function evaluatePermissionRules(rules, value) {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return "ask";
  let action = "ask";
  let matched = false;
  for (const [pattern, rule] of Object.entries(rules)) {
    if (!permissionPatternMatches(pattern, value)) continue;
    const normalized = String(rule || "").trim().toLowerCase();
    if (normalized === "allow" || normalized === "deny" || normalized === "ask") {
      action = normalized;
      matched = true;
    }
  }
  return matched ? action : "ask";
}

function unquote(value) {
  const text = String(value ?? "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Indentation-sensitive YAML subset for agent frontmatter.
 * Handles nested maps and quoted keys. It is not a general YAML parser.
 */
export function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.trim();
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = unquote(line.slice(0, separator));
    const rest = line.slice(separator + 1).trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (!rest) {
      const child = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = unquote(rest);
    }
  }
  return root;
}

export function parseAgentFrontmatter(markdown) {
  const match = String(markdown ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  return parseSimpleYaml(match[1]);
}

export function agentPermission(markdown) {
  const frontmatter = parseAgentFrontmatter(markdown);
  const permission = frontmatter.permission;
  return permission && typeof permission === "object" ? permission : {};
}
