import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { classify } from "../../scripts/lib/classify.js";
import { classifyFromArgs } from "../../scripts/nexus-classify.js";
import {
  collectGitDiffEvidence,
  mergeGitDiffEvidence,
} from "../../scripts/lib/diff-evidence.js";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeFile(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-diff-"));
  writeFile(
    root,
    "package.json",
    JSON.stringify(
      {
        name: "diff-fixture",
        private: true,
        workspaces: ["packages/*"],
      },
      null,
      2,
    ) + "\n",
  );
  writeFile(root, "src/index.js", "export const answer = 1;\n");
  writeFile(root, "tests/index.test.js", "assert.equal(answer, 1);\n");
  writeFile(root, "packages/a/package.json", '{"name":"@fixture/a"}\n');
  writeFile(root, "packages/a/src/a.js", "export const alpha = 1;\n");
  writeFile(root, "packages/b/package.json", '{"name":"@fixture/b"}\n');
  writeFile(root, "packages/b/src/b.js", "export const beta = 1;\n");

  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "nexus-test@example.invalid"]);
  git(root, ["config", "user.name", "Nexus Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  return root;
}

test("git diff evidence is deterministic and records boundaries", () => {
  const root = createGitRepo();
  writeFile(root, "src/index.js", "export const answer = 2;\nexport function added() {}\n");
  writeFile(root, "tests/index.test.js", "assert.equal(answer, 2);\n");
  writeFile(root, "packages/a/src/a.js", "export const alpha = 2;\n");
  writeFile(root, "packages/b/src/b.js", "export const beta = 2;\n");

  const evidence = collectGitDiffEvidence({ cwd: root });
  assert.equal(evidence.evidence_source, "git-diff");
  assert.equal(evidence.diff_available, true);
  assert.equal(evidence.diff_clean, false);
  assert.equal(evidence.files_changed, 4);
  assert.ok(evidence.added_lines > 0);
  assert.ok(evidence.deleted_lines > 0);
  assert.ok(evidence.changed_exported_symbols.includes("answer"));
  assert.ok(evidence.changed_exported_symbols.includes("added"));
  assert.deepEqual(evidence.changed_test_files, ["tests/index.test.js"]);
  assert.deepEqual(evidence.package_boundaries, [".", "packages/a", "packages/b"]);
  assert.deepEqual(evidence.workspace_boundaries, ["packages/a", "packages/b"]);
  assert.equal(evidence.cross_package_change, true);

  const merged = mergeGitDiffEvidence(
    {
      filesChanged: 999,
      estimatedLines: 999,
      changeClass: "small-feature-with-tests",
    },
    evidence,
  );
  assert.equal(merged.filesChanged, 4);
  assert.equal(merged.estimatedLines, evidence.estimated_lines);
  assert.deepEqual(merged.compatibility_input, {
    filesChanged: 999,
    estimatedLines: 999,
  });

  const classification = classify(merged);
  assert.equal(classification.evidence_source, "git-diff");
  assert.equal(classification.direct_eligible, false);
  assert.ok(classification.reasons.some((reason) => /Git diff evidence/.test(reason)));
});

test("classification CLI emits git evidence and keeps clean diff delegated", () => {
  const root = createGitRepo();
  writeFile(root, "README.md", "changed\n");
  const changedResult = classifyFromArgs(
    ["--diff", "--class", "documentation", "--focused"],
    root,
  );
  assert.equal(changedResult.evidence_source, "git-diff");
  assert.deepEqual(changedResult.changed_files, ["README.md"]);
  assert.match(changedResult.reasons.join("\n"), /Git diff evidence/);

  git(root, ["add", "README.md"]);
  git(root, ["commit", "-qm", "change"]);
  const cleanResult = classifyFromArgs(
    [
      "--diff",
      "--files",
      "1",
      "--lines",
      "10",
      "--class",
      "documentation",
      "--focused",
    ],
    root,
  );
  assert.equal(cleanResult.evidence_source, "git-diff");
  assert.deepEqual(cleanResult.changed_files, []);
  assert.equal(cleanResult.direct_eligible, false);
  assert.equal(cleanResult.execution_mode, "delegated");
  assert.match(cleanResult.reasons.join("\n"), /no changed files|clean or unavailable/i);
});

test("compatibility estimates never authorize direct execution", () => {
  const root = createGitRepo();
  const result = classifyFromArgs(
    [
      "--no-diff",
      "--files",
      "1",
      "--lines",
      "10",
      "--class",
      "documentation",
      "--focused",
    ],
    root,
  );
  assert.notEqual(result.evidence_source, "git-diff");
  assert.equal(result.direct_eligible, false);
  assert.equal(result.execution_mode, "delegated");
});

test("CLI collects current git diff by default", () => {
  const root = createGitRepo();
  writeFile(root, "README.md", "direct-safe documentation change\n");
  const result = classifyFromArgs(
    ["--class", "documentation", "--focused"],
    root,
  );
  assert.equal(result.evidence_source, "git-diff");
  assert.equal(result.diff_verified, true);
  assert.equal(result.direct_eligible, true);
  assert.equal(result.execution_mode, "direct");
});
