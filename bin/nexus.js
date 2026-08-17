#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));

const USAGE = `OpenCode Nexus ${pkg.version}

Usage:
  nexus <command> [flags]

Commands:
  install     Install or update OpenCode agents and plugin config
  update      Same as install (idempotent)
  uninstall   Remove Nexus OpenCode agents and plugin config
  version     Print the package version
  doctor      Check local prerequisites and install status
  help        Show this message

Examples:
  npx ${pkg.name}@latest install
  npx ${pkg.name}@latest install --with-optional-agents
  nexus update
  nexus uninstall
  nexus doctor

Install flags are forwarded to install.sh:
  --with-optional-agents
  --prune-optional-agents
`;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function runBash(scriptName, args) {
  const script = path.join(pkgRoot, scriptName);
  if (!fs.existsSync(script)) {
    fail(`Missing ${scriptName} in ${pkgRoot}`);
  }
  const child = spawn("bash", [script, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("error", (err) => {
    if (err.code === "ENOENT") {
      fail("bash is required to install or uninstall Nexus (Git Bash or WSL on Windows).");
    }
    fail(err.message);
  });
  child.on("exit", (code, signal) => {
    if (signal) fail(`Terminated by ${signal}`, 1);
    process.exit(code ?? 1);
  });
}

function hasCommand(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  const exts =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, name + ext))) return true;
      } catch {
        // ignore unreadable PATH entries
      }
    }
  }
  return false;
}

function pluginEntries(config) {
  return Array.isArray(config.plugin) ? config.plugin : [];
}

function isNexusPluginSpec(spec) {
  if (typeof spec !== "string") return false;
  return (
    spec === pkg.name ||
    spec.startsWith(`${pkg.name}@`) ||
    spec === "nexus@git+https://github.com/mohammad154/opencode-nexus.git"
  );
}

function doctor() {
  const configDir =
    process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode");
  const configFile = path.join(configDir, "opencode.json");
  const agentsDir = path.join(configDir, "agents");
  const canonical = [
    "orchestrator",
    "implementer",
    "unified-reviewer",
    "spec-reviewer",
    "code-reviewer",
    "reconciler",
  ];

  const rows = [
    ["node", true, process.version],
    ["bash", hasCommand("bash"), hasCommand("bash") ? "found" : "missing"],
    ["jq", hasCommand("jq"), hasCommand("jq") ? "found" : "missing (required to install)"],
    ["git", hasCommand("git"), hasCommand("git") ? "found" : "missing"],
    [
      "graphify",
      hasCommand("graphify"),
      hasCommand("graphify") ? "found" : "missing (required to install)",
    ],
    [
      "opencode",
      hasCommand("opencode"),
      hasCommand("opencode") ? "found" : "not detected (config can still be installed)",
    ],
  ];

  let pluginOk = false;
  let pluginDetail = `no ${configFile}`;
  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
      const matches = pluginEntries(config).filter(isNexusPluginSpec);
      pluginOk = matches.length === 1;
      pluginDetail = pluginOk
        ? matches[0]
        : matches.length === 0
          ? "plugin not configured"
          : `unexpected plugin entries: ${matches.join(", ")}`;
    } catch (err) {
      pluginDetail = `unreadable: ${err.message}`;
    }
  }
  rows.push(["plugin", pluginOk, pluginDetail]);

  const missingAgents = canonical.filter(
    (name) => !fs.existsSync(path.join(agentsDir, `${name}.md`)),
  );
  rows.push([
    "agents",
    missingAgents.length === 0,
    missingAgents.length === 0
      ? `${canonical.length} canonical agents in ${agentsDir}`
      : `missing: ${missingAgents.join(", ")}`,
  ]);

  const width = Math.max(...rows.map(([name]) => name.length));
  let failed = 0;
  console.log(`Nexus ${pkg.version} (${pkg.name})`);
  console.log(`Package root: ${pkgRoot}`);
  console.log(`CLI path: ${process.argv[1] || "unknown"}`);
  console.log("");
  for (const [name, ok, detail] of rows) {
    const mark = ok ? "ok" : "!!";
    if (!ok) failed += 1;
    console.log(`${mark}  ${name.padEnd(width)}  ${detail}`);
  }
  if (failed > 0) {
    console.log("");
    console.log(`${failed} check(s) failed. Run: nexus install`);
    process.exit(1);
  }
  console.log("");
  console.log("All checks passed.");
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "install":
  case "update":
    console.log(`OpenCode Nexus ${pkg.version} from ${pkgRoot}`);
    runBash("install.sh", args);
    break;
  case "uninstall":
    runBash("uninstall.sh", args);
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(pkg.version);
    break;
  case "doctor":
    doctor();
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(USAGE.trimEnd());
    break;
  default:
    fail(`${USAGE.trimEnd()}\n\nError: unknown command: ${command}`);
}
