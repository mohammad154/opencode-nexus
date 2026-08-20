#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectInit } from "../scripts/lib/project-init.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));

const USAGE = `OpenCode Nexus ${pkg.version}

Usage:
  nexus <command> [flags]

Commands:
  install        Install or update OpenCode agents and plugin config
  update         Same as install (idempotent)
  uninstall      Remove Nexus OpenCode agents and plugin config
  project-init   Bootstrap .opencode/ in the current project (external repos)
  run            Workflow state machine (init, classify, transition, status, inspect, ...)
  impact         Nexus Impact Engine (git + AST + affected tests)
  blast          Alias for impact (compatibility)
  classify       Risk classifier CLI
  estimate       Estimate minimum agent calls for a plan
  version        Print the package version
  doctor         Check local prerequisites and project readiness
  help           Show this message

Examples:
  npx ${pkg.name}@latest install
  nexus project-init
  nexus run init --run-id demo
  nexus run status
  nexus run inspect
  nexus classify --files 2 --lines 40 --class small-feature-with-tests --focused
  nexus impact --json
  nexus estimate --tasks 3 --profile balanced
  nexus doctor

Install flags are forwarded to install.sh:
  --with-optional-agents
  --prune-optional-agents

Clone-dev fallback (inside this repo only):
  node scripts/nexus-run.js ...
`;

const RUN_HELP = `Usage: nexus run <subcommand> [flags]

Subcommands:
  init              Create a run (--run-id <id>)
  classify          Classify and optionally apply (--apply)
  transition        Transition state (--to STATE)
  validate-handoff  Validate a handoff JSON (--role ROLE --file path)
  status            Show run state
  resume            Resume from durable state
  drift             Assess plan drift
  can-transition    Check if a transition is legal
  inspect           Trajectory + artifact digests + gate failures

Exit codes: 0 ok, 2 validation failure, 3 illegal transition
`;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function scriptPath(name) {
  const p = path.join(pkgRoot, "scripts", name);
  if (!fs.existsSync(p)) {
    fail(`Missing scripts/${name} in ${pkgRoot}`);
  }
  return p;
}

function runNodeScript(scriptName, args, { cwd = process.cwd() } = {}) {
  const script = scriptPath(scriptName);
  const child = spawn(process.execPath, [script, ...args], {
    stdio: "inherit",
    cwd,
    env: {
      ...process.env,
      NEXUS_PKG_ROOT: pkgRoot,
    },
  });
  child.on("error", (err) => {
    fail(err.message);
  });
  child.on("exit", (code, signal) => {
    if (signal) fail(`Terminated by ${signal}`, 1);
    process.exit(code ?? 1);
  });
}

function runNodeScriptSync(scriptName, args, { cwd = process.cwd() } = {}) {
  const script = scriptPath(scriptName);
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    cwd,
    env: {
      ...process.env,
      NEXUS_PKG_ROOT: pkgRoot,
    },
  });
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

function isGitRepo(cwd = process.cwd()) {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
  });
  return r.status === 0 && String(r.stdout || "").trim() === "true";
}

function readActiveRunSummary(worktree) {
  const runsRoot = path.join(worktree, ".opencode", "runs");
  if (!fs.existsSync(runsRoot)) return null;
  try {
    const dirs = fs
      .readdirSync(runsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    let best = null;
    for (const id of dirs) {
      const p = path.join(runsRoot, id, "state.json");
      if (!fs.existsSync(p)) continue;
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      if (s.state === "COMPLETED" || s.state === "FAILED") continue;
      if (!best || (s.updated_at || "") > (best.updated_at || "")) best = s;
    }
    return best;
  } catch {
    return null;
  }
}

function cmdProjectInit() {
  const worktree = process.cwd();
  const result = projectInit(worktree, {
    pkgVersion: pkg.version,
    pkgName: pkg.name,
    pkgRoot,
  });

  // Project-level Graphify wiring (instructions + plugin) belongs here, scoped
  // to the current project — NOT in the global `nexus install`, which may run
  // from an arbitrary directory and must not mutate an unrelated project.
  let graphify = { attempted: false, ok: null, detail: "graphify not found on PATH" };
  if (hasCommand("graphify")) {
    graphify = { attempted: true, ok: false, detail: null };
    const r = spawnSync("graphify", ["opencode", "install"], {
      cwd: worktree,
      encoding: "utf8",
    });
    graphify.ok = r.status === 0;
    graphify.detail = graphify.ok
      ? "graphify opencode install completed"
      : `graphify opencode install failed (exit ${r.status ?? "unknown"}): ${
          (r.stderr || r.stdout || "").trim() || "no output"
        }`;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        message: "Nexus project bootstrap complete",
        ...result,
        graphify,
      },
      null,
      2,
    ),
  );
}

function cmdRun(args) {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    console.log(RUN_HELP.trimEnd());
    return;
  }
  runNodeScript("nexus-run.js", args);
}

function cmdBlast(args) {
  runNodeScript("nexus-blast.js", args);
}

function cmdImpact(args) {
  runNodeScript("nexus-impact.js", args);
}

function cmdClassify(args) {
  runNodeScript("nexus-classify.js", args);
}

function cmdEstimate(args) {
  runNodeScript("nexus-estimate-calls.js", args);
}

function doctor() {
  const configDir =
    process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode");
  const configFile = path.join(configDir, "opencode.json");
  const agentsDir = path.join(configDir, "agents");
  const worktree = process.cwd();
  const canonical = [
  "orchestrator",
  "implementer",
  "unified-reviewer",
  "spec-reviewer",
  "code-reviewer",
  "reconciler",
  "diagnostician",
  "integration-reviewer",
];

  const rows = [
    ["node", true, process.version],
    ["bash", hasCommand("bash"), hasCommand("bash") ? "found" : "missing"],
    ["jq", hasCommand("jq"), hasCommand("jq") ? "found" : "missing (required to install)"],
    ["git", hasCommand("git"), hasCommand("git") ? "found" : "missing"],
    [
      "impact-engine",
      fs.existsSync(scriptPath("nexus-impact.js")),
      "scripts/nexus-impact.js (Nexus Impact Engine)",
    ],
    [
      "opencode",
      hasCommand("opencode"),
      hasCommand("opencode") ? "found" : "not detected (config can still be installed)",
    ],
    [
      "cli-run",
      fs.existsSync(scriptPath("nexus-run.js")),
      "nexus run forwards to package scripts/nexus-run.js",
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

  if (isGitRepo(worktree)) {
    const opencodeDir = path.join(worktree, ".opencode");
    const opencodeOk = fs.existsSync(opencodeDir);
    rows.push([
      "project-opencode",
      opencodeOk,
      opencodeOk
        ? `.opencode/ present in ${worktree}`
        : "missing — run: nexus project-init",
    ]);

    const graphPath = path.join(worktree, "graphify-out", "graph.json");
    const graphOk = fs.existsSync(graphPath);
    rows.push([
      "project-graph",
      graphOk,
      graphOk
        ? "graphify-out/graph.json present"
        : "missing — run: graphify extract . --code-only --directed --no-viz",
    ]);

    const activeRun = readActiveRunSummary(worktree);
    if (activeRun) {
      rows.push([
        "project-run",
        activeRun.state !== "BLOCKED",
        `active run ${activeRun.run_id}: ${activeRun.state}${
          activeRun.state === "BLOCKED" ? " — reconcile before continuing" : ""
        }`,
      ]);
    } else {
      const status = runNodeScriptSync("nexus-run.js", ["status"], { cwd: worktree });
      const statusOk = status.status === 0;
      rows.push([
        "project-run",
        statusOk,
        statusOk
          ? "nexus run status ok (no active non-terminal run)"
          : `nexus run status failed (exit ${status.status ?? "unknown"})`,
      ]);
    }
  }

  const width = Math.max(...rows.map(([name]) => name.length));
  let failed = 0;
  console.log(`Nexus ${pkg.version} (${pkg.name})`);
  console.log(`Package root: ${pkgRoot}`);
  console.log(`CLI path: ${process.argv[1] || "unknown"}`);
  console.log(`Worktree: ${worktree}`);
  console.log("");
  for (const [name, ok, detail] of rows) {
    const mark = ok ? "ok" : "!!";
    if (!ok) failed += 1;
    console.log(`${mark}  ${name.padEnd(width)}  ${detail}`);
  }
  if (failed > 0) {
    console.log("");
    console.log(`${failed} check(s) failed. Run: nexus install && nexus project-init`);
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
  case "project-init":
    cmdProjectInit();
    break;
  case "run":
    cmdRun(args);
    break;
  case "blast":
    cmdBlast(args);
    break;
  case "impact":
    cmdImpact(args);
    break;
  case "classify":
    cmdClassify(args);
    break;
  case "estimate":
    cmdEstimate(args);
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
