import fs from "node:fs";
import path from "node:path";

const WINDOWS_PATH_DELIMITER = ";";
const DEFAULT_WINDOWS_PATHEXT = Object.freeze([
  ".COM",
  ".EXE",
  ".BAT",
  ".CMD",
]);

function environmentValue(env, name) {
  if (!env || typeof env !== "object") return undefined;
  const wanted = name.toUpperCase();
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === wanted);
  return key == null ? undefined : env[key];
}

function parseWindowsPathExt(env) {
  const configured = environmentValue(env, "PATHEXT");
  const raw = configured == null || configured === ""
    ? DEFAULT_WINDOWS_PATHEXT.join(WINDOWS_PATH_DELIMITER)
    : String(configured);
  const extensions = [];

  for (const entry of raw.split(WINDOWS_PATH_DELIMITER)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const extension = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    // PATHEXT entries are suffixes, never paths. Ignore malformed environment
    // values rather than allowing them to change the lookup root.
    if (!/^\.[A-Z0-9]+$/i.test(extension)) continue;
    const key = extension.toUpperCase();
    if (extensions.some((candidate) => candidate.toUpperCase() === key)) continue;
    extensions.push(extension);
  }

  return extensions.length > 0 ? extensions : DEFAULT_WINDOWS_PATHEXT;
}

function isPathQualified(command) {
  return /[\\/]/.test(command) || /^[A-Za-z]:/.test(command);
}

function hasExplicitExtension(command) {
  return path.win32.extname(command) !== "";
}

function cleanPathEntry(entry) {
  const value = String(entry).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function isRegularFile(candidate, fsModule) {
  try {
    return fsModule.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a command to a concrete executable on Windows without invoking a
 * shell. A missing Windows resolution returns the original command so the
 * caller retains the normal spawnSync failure and evidence semantics.
 *
 * `pathModule` and `fsModule` are injectable for portable Windows regression
 * tests running on a non-Windows host. Production callers use the native
 * modules by default.
 */
export function resolveExecutable(command, {
  platform = process.platform,
  env = process.env,
  cwd = process.cwd(),
  fsModule = fs,
  pathModule = path,
  isFile = null,
} = {}) {
  if (platform !== "win32" || typeof command !== "string" || command.includes("\0")) {
    return command;
  }

  const fileCheck = typeof isFile === "function"
    ? isFile
    : (candidate) => isRegularFile(candidate, fsModule);
  const extensions = hasExplicitExtension(command) ? [""] : parseWindowsPathExt(env);
  const qualified = isPathQualified(command);
  const bases = [];

  if (qualified) {
    bases.push(pathModule.isAbsolute(command) ? command : pathModule.resolve(cwd, command));
  } else {
    const configuredPath = environmentValue(env, "PATH");
    const pathEntries = configuredPath == null
      ? []
      : String(configuredPath).split(WINDOWS_PATH_DELIMITER);
    for (const rawEntry of pathEntries) {
      const entry = cleanPathEntry(rawEntry);
      const directory = entry || cwd;
      bases.push(
        pathModule.isAbsolute(directory)
          ? pathModule.join(directory, command)
          : pathModule.resolve(cwd, directory, command),
      );
    }
  }

  for (const base of bases) {
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      if (fileCheck(candidate)) return candidate;
    }
  }

  return command;
}
