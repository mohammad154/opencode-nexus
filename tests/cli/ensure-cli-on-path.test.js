import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BIN_NAMES,
  RC_MARKER,
  SHIM_MARKER,
  ensureUserBinOnPath,
  isGlobalInstall,
  isOurShim,
  pathHasDir,
  removeShims,
  resolveInstallHome,
  run,
  userBinDir,
  writeShims,
} from "../../scripts/ensure-cli-on-path.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const targetBin = path.join(repoRoot, "bin", "nexus.js");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cli-path-"));
}

function silentLog() {
  const lines = [];
  return {
    lines,
    log: (...args) => lines.push(args.join(" ")),
    warn: (...args) => lines.push(args.join(" ")),
  };
}

test("local installs are skipped so npx/cache installs do not pollute PATH", () => {
  const home = tempHome();
  try {
    const result = run([], {
      home,
      env: { PATH: "/usr/bin:/bin" },
      pkgRoot: repoRoot,
      log: silentLog(),
    });
    assert.equal(result.action, "skip");
    assert.equal(fs.existsSync(userBinDir(home)), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("global install links nexus and opencode-nexus into ~/.local/bin", () => {
  const home = tempHome();
  try {
    const binDir = userBinDir(home);
    const result = run([], {
      home,
      env: {
        PATH: `${binDir}${path.delimiter}/usr/bin`,
        npm_config_global: "true",
      },
      pkgRoot: repoRoot,
      log: silentLog(),
    });
    assert.equal(result.action, "ensure");
    for (const name of BIN_NAMES) {
      const dest = path.join(binDir, name);
      assert.equal(fs.existsSync(dest), true, dest);
      assert.equal(isOurShim(dest), true);
      const body = fs.readFileSync(dest, "utf8");
      assert.match(body, new RegExp(SHIM_MARKER));
      assert.equal(body.includes(targetBin), true);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("global install is detected from npm prefix even without npm_config_global", () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-prefix-"));
  const root = path.join(
    prefix,
    "lib",
    "node_modules",
    "@mohammad154",
    "opencode-nexus",
  );
  try {
    assert.equal(isGlobalInstall({ npm_config_prefix: prefix }, root), true);
    assert.equal(isGlobalInstall({}, repoRoot), false);
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});

test("does not overwrite an unrelated nexus command", () => {
  const home = tempHome();
  try {
    const binDir = userBinDir(home);
    fs.mkdirSync(binDir, { recursive: true });
    const foreign = path.join(binDir, "nexus");
    fs.writeFileSync(foreign, "#!/bin/sh\necho foreign\n", { mode: 0o755 });
    const result = writeShims({ home, targetBin });
    assert.deepEqual(result.skipped, [foreign]);
    assert.equal(fs.readFileSync(foreign, "utf8"), "#!/bin/sh\necho foreign\n");
    assert.equal(isOurShim(path.join(binDir, "opencode-nexus")), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("remove only deletes shims this package created", () => {
  const home = tempHome();
  try {
    const binDir = userBinDir(home);
    writeShims({ home, targetBin });
    fs.writeFileSync(path.join(binDir, "keep-me"), "ok\n");
    const result = run(["--remove"], {
      home,
      env: {},
      pkgRoot: repoRoot,
      log: silentLog(),
    });
    assert.equal(result.action, "remove");
    assert.equal(fs.existsSync(path.join(binDir, "nexus")), false);
    assert.equal(fs.existsSync(path.join(binDir, "opencode-nexus")), false);
    assert.equal(fs.readFileSync(path.join(binDir, "keep-me"), "utf8"), "ok\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("PATH helper is a no-op when ~/.local/bin is already on PATH", () => {
  const home = tempHome();
  try {
    const binDir = userBinDir(home);
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(home, ".bashrc"), "export PATH=/usr/bin\n");
    const result = ensureUserBinOnPath({
      home,
      pathEnv: `${binDir}${path.delimiter}/usr/bin`,
    });
    assert.equal(result.alreadyOnPath, true);
    assert.deepEqual(result.updated, []);
    assert.equal(
      fs.readFileSync(path.join(home, ".bashrc"), "utf8"),
      "export PATH=/usr/bin\n",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("PATH helper appends a snippet once when ~/.local/bin is missing from PATH", () => {
  const home = tempHome();
  try {
    fs.mkdirSync(userBinDir(home), { recursive: true });
    const bashrc = path.join(home, ".bashrc");
    fs.writeFileSync(bashrc, "export PATH=/usr/bin\n");
    const first = ensureUserBinOnPath({ home, pathEnv: "/usr/bin:/bin" });
    assert.equal(first.alreadyOnPath, false);
    assert.deepEqual(first.updated, [bashrc]);
    const text = fs.readFileSync(bashrc, "utf8");
    assert.match(text, new RegExp(RC_MARKER));
    const second = ensureUserBinOnPath({ home, pathEnv: "/usr/bin:/bin" });
    assert.deepEqual(second.updated, []);
    assert.equal(fs.readFileSync(bashrc, "utf8"), text);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pathHasDir matches the user bin directory", () => {
  const home = tempHome();
  try {
    const binDir = userBinDir(home);
    assert.equal(
      pathHasDir(binDir, `/usr/bin${path.delimiter}${binDir}`),
      true,
    );
    assert.equal(pathHasDir(binDir, "/usr/bin:/bin"), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("removeShims ignores missing home bin dir", () => {
  const home = tempHome();
  try {
    const result = removeShims({ home });
    assert.deepEqual(result.removed, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sudo global install writes shims to the invoking user's home", () => {
  const userHome = tempHome();
  try {
    const result = run([], {
      env: {
        PATH: "/usr/bin:/bin",
        npm_config_global: "true",
        SUDO_USER: "danaee",
      },
      getuid: () => 0,
      sudoHome: () => userHome,
      pkgRoot: repoRoot,
      log: silentLog(),
    });
    assert.equal(result.action, "ensure");
    assert.equal(fs.existsSync(path.join(userBinDir(userHome), "nexus")), true);
  } finally {
    fs.rmSync(userHome, { recursive: true, force: true });
  }
});

test("resolveInstallHome ignores SUDO_USER when not root", () => {
  assert.equal(
    resolveInstallHome({
      env: { SUDO_USER: "danaee" },
      homedir: "/home/current",
      getuid: () => 1000,
    }),
    "/home/current",
  );
});

test("resolveInstallHome maps root+SUDO_USER to that user's home", () => {
  assert.equal(
    resolveInstallHome({
      env: { SUDO_USER: "danaee" },
      homedir: "/root",
      getuid: () => 0,
      sudoHome: (user) => `/home/${user}`,
    }),
    "/home/danaee",
  );
});
