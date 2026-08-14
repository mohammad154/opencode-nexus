#!/usr/bin/env node
/**
 * After `npm install -g`, npm puts `nexus` in `$prefix/bin`. Many users set a
 * custom prefix (e.g. ~/.npm-global) that is not on PATH, so the next command
 * (`nexus install`) fails with "command not found".
 *
 * On global install, link the CLI into ~/.local/bin (XDG user bin, usually on
 * PATH on Linux/WSL) and, if needed, append a PATH snippet to existing shell rc
 * files. Never fail the npm install if this helper cannot update PATH.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pkg = JSON.parse(
  fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"),
);

export const SHIM_MARKER = "opencode-nexus-cli-shim";
export const BIN_NAMES = ["nexus", "opencode-nexus"];
export const RC_MARKER = "# opencode-nexus CLI PATH";

const RC_SNIPPET = `${RC_MARKER}
if [ -d "$HOME/.local/bin" ]; then
  case ":$PATH:" in
    *:"$HOME/.local/bin":*) ;;
    *) export PATH="$HOME/.local/bin:$PATH" ;;
  esac
fi
`;

export function userBinDir(home = os.homedir()) {
  return path.join(home, ".local", "bin");
}

export function isTruthy(value) {
  return value === "true" || value === "1" || value === "TRUE";
}

export function isGlobalInstall(env = process.env, root = pkgRoot) {
  if (isTruthy(env.npm_config_global)) return true;
  if (isTruthy(env.BUN_INSTALL_GLOBAL)) return true;
  const prefix = env.npm_config_prefix;
  if (prefix) {
    const resolvedRoot = path.resolve(root);
    const candidates = [
      path.join(path.resolve(prefix), "lib", "node_modules"),
      path.join(path.resolve(prefix), "node_modules"),
    ];
    if (
      candidates.some(
        (dir) =>
          resolvedRoot === dir || resolvedRoot.startsWith(dir + path.sep),
      )
    ) {
      return true;
    }
  }
  const bunGlobal = path.join(".bun", "install", "global", "node_modules");
  if (root.includes(bunGlobal)) return true;
  return false;
}

export function pathHasDir(dir, pathEnv = process.env.PATH || "") {
  const resolved = path.resolve(dir);
  return pathEnv.split(path.delimiter).some((entry) => {
    if (!entry) return false;
    try {
      return path.resolve(entry) === resolved;
    } catch {
      return false;
    }
  });
}

export function shimContents(targetBin, nodeExec = process.execPath) {
  if (process.platform === "win32") {
    return `@echo off\r\nREM ${SHIM_MARKER}\r\n"${nodeExec}" "${targetBin}" %*\r\n`;
  }
  return `#!/bin/sh\n# ${SHIM_MARKER}\nexec "${nodeExec}" "${targetBin}" "$@"\n`;
}

export function isOurShim(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      return (
        target.includes("opencode-nexus") &&
        target.endsWith(`${path.sep}bin${path.sep}nexus.js`)
      );
    }
    if (!stat.isFile()) return false;
    return fs.readFileSync(file, "utf8").includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

function shimPath(binDir, name) {
  return process.platform === "win32"
    ? path.join(binDir, `${name}.cmd`)
    : path.join(binDir, name);
}

export function writeShims({
  home,
  targetBin,
  nodeExec = process.execPath,
} = {}) {
  const binDir = userBinDir(home);
  fs.mkdirSync(binDir, { recursive: true });
  const written = [];
  const skipped = [];
  for (const name of BIN_NAMES) {
    const dest = shimPath(binDir, name);
    let exists = false;
    try {
      fs.lstatSync(dest);
      exists = true;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    if (exists && !isOurShim(dest)) {
      skipped.push(dest);
      continue;
    }
    if (exists) fs.rmSync(dest, { force: true });
    fs.writeFileSync(dest, shimContents(targetBin, nodeExec), { mode: 0o755 });
    fs.chmodSync(dest, 0o755);
    written.push(dest);
  }
  return { binDir, written, skipped };
}

export function removeShims({ home } = {}) {
  const binDir = userBinDir(home);
  const removed = [];
  for (const name of BIN_NAMES) {
    const dest = shimPath(binDir, name);
    if (isOurShim(dest)) {
      fs.rmSync(dest, { force: true });
      removed.push(dest);
    }
  }
  return { binDir, removed };
}

export function ensureUserBinOnPath({
  home,
  pathEnv = process.env.PATH || "",
} = {}) {
  const binDir = userBinDir(home);
  if (pathHasDir(binDir, pathEnv)) {
    return { binDir, alreadyOnPath: true, updated: [] };
  }
  const rcFiles = [
    ".profile",
    ".bashrc",
    ".zshrc",
    ".zprofile",
    ".bash_profile",
  ].map((name) => path.join(home, name));
  const updated = [];
  for (const file of rcFiles) {
    if (!fs.existsSync(file)) continue;
    const current = fs.readFileSync(file, "utf8");
    if (current.includes(RC_MARKER)) continue;
    const suffix = current.endsWith("\n") || current.length === 0 ? "" : "\n";
    fs.writeFileSync(file, `${current}${suffix}\n${RC_SNIPPET}`);
    updated.push(file);
  }
  return { binDir, alreadyOnPath: false, updated };
}

export function run(argv = process.argv.slice(2), options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const root = options.pkgRoot ?? pkgRoot;
  const targetBin = path.join(root, "bin", "nexus.js");
  const log = options.log ?? console;
  const remove = argv.includes("--remove");

  if (remove) {
    const result = removeShims({ home });
    if (result.removed.length > 0) {
      log.log(`Removed Nexus CLI shims from ${result.binDir}`);
    }
    return { action: "remove", ...result };
  }

  if (!isGlobalInstall(env, root)) {
    return { action: "skip", reason: "not-global" };
  }

  const shims = writeShims({
    home,
    targetBin,
    nodeExec: options.nodeExec ?? process.execPath,
  });
  const pathFix = ensureUserBinOnPath({ home, pathEnv: env.PATH || "" });
  const onPath = pathHasDir(shims.binDir, env.PATH || "");

  log.log(`OpenCode Nexus ${pkg.version} CLI installed.`);
  if (shims.written.length > 0) {
    log.log(`Linked: ${shims.written.join(", ")}`);
  }
  if (shims.skipped.length > 0) {
    log.warn(
      `Left existing commands in place (not overwriting): ${shims.skipped.join(", ")}`,
    );
  }
  if (pathFix.updated.length > 0) {
    log.log(`Added ~/.local/bin to PATH in: ${pathFix.updated.join(", ")}`);
  }

  log.log("");
  if (
    onPath ||
    shims.written.some((file) => path.basename(file).startsWith("nexus"))
  ) {
    if (onPath) {
      log.log("Next:  nexus install");
    } else {
      log.log("This shell cannot see ~/.local/bin yet. Run:");
      log.log("");
      log.log(`  export PATH="${shims.binDir}:$PATH"`);
      log.log("  nexus install");
      log.log("");
      log.log("Or skip PATH and run:");
      log.log(`  npx ${pkg.name}@latest install`);
    }
  } else {
    log.log(`Next:  npx ${pkg.name}@latest install`);
  }

  return { action: "ensure", shims, pathFix, onPath };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    run();
  } catch (err) {
    console.warn(
      `opencode-nexus: could not expose the nexus command (${err.message})`,
    );
    console.warn(`Run: npx ${pkg.name}@latest install`);
  }
}
