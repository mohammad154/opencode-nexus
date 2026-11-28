#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

/**
 * A developer's shell may point Nexus at another worktree or keep baselines.
 * NODE_TEST_CONTEXT makes a nested `node --test` report to its parent instead
 * of running the files, so it is removed too. Tests must not inherit either.
 */
const HERMETIC_UNSET = [
  "NEXUS_WORKTREE",
  "NEXUS_KEEP_PRIVATE_BASELINE",
  "NEXUS_FAST_PATH",
  "NODE_TEST_CONTEXT",
];

function compareNames(left, right) {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

/**
 * Find Node test files without relying on shell glob expansion.
 *
 * @param {string} testRoot
 * @returns {string[]}
 */
export function discoverTestFiles(testRoot) {
  const files = [];

  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    entries.sort(compareNames);
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
        files.push(entryPath);
      }
    }
  }

  visit(testRoot);
  return files;
}

/**
 * Run the discovered files as explicit child-process arguments. Passing each
 * path as an argv item keeps spaces, separators, and quoting out of any shell.
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot]
 * @param {string} [options.testRoot]
 * @param {string|Array} [options.stdio]
 * @returns {{status: number, signal: string|null, error: Error|null, testFiles: string[]}}
 */
export function runTests({
  projectRoot: root = projectRoot,
  testRoot = path.join(root, "tests"),
  stdio = "inherit",
} = {}) {
  const testFiles = discoverTestFiles(testRoot);
  if (testFiles.length === 0) {
    return {
      status: 1,
      signal: null,
      error: new Error(`No test files found under ${testRoot}`),
      testFiles,
    };
  }

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-test-state-"));
  const env = { ...process.env, NEXUS_STATE_DIR: stateDir };
  for (const name of HERMETIC_UNSET) delete env[name];
  let result;
  try {
    result = spawnSync(process.execPath, ["--test", ...testFiles], {
      cwd: root,
      env,
      shell: false,
      stdio,
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  return {
    status:
      typeof result.status === "number"
        ? result.status
        : result.error || result.signal
          ? 1
          : 0,
    signal: result.signal || null,
    error: result.error || null,
    testFiles,
  };
}

function main() {
  const result = runTests();
  if (result.error) {
    console.error(`[nexus-test-runner] ${result.error.message}`);
  }
  if (result.signal) {
    console.error(`[nexus-test-runner] test process terminated by ${result.signal}`);
  }
  return result.status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main();
}
