import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assessOrchestratorBash } from "../scripts/lib/orchestrator-bash.js";
import { assessImplementerBash } from "../scripts/lib/orchestrator-edit.js";

function worktreeWith(files = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-bash-wt-"));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "x\n");
  }
  return dir;
}

function decide(command, options = {}) {
  const result = assessOrchestratorBash(command, options);
  return result.ok ? result.action : "deny";
}

const DENY = [
  "find . -delete",
  "find . -name '*.log' -delete",
  "find -delete",
  "find . -exec rm -rf {} +",
  "find . -execdir rm {} +",
  "find . -ok rm {} +",
  "find . -okdir rm {} +",
  "find . -fprint out.txt",
  "find . -fprint0 out.txt",
  "find . -fprintf out.txt %p",
  "find . -fls out.txt",
  "find . -type f -fls out.txt -print",
  "rg --pre cat needle",
  "rg needle --pre=cat",
  "rg needle --pre-glob '*.gz' src",
  "grep --pre cat needle src",
  "sed -i s/a/b/ file",
  "sed -n 1p file",
  "awk 'BEGIN { system(\"id\") }'",
  "tee out.txt",
  "git log | tee out",
  "ls | xargs rm",
  "less file",
  "more file",
  "vim file",
  "node -e 'process.exit(0)'",
  "perl -e 1",
  "git -c core.pager=sh log",
  "git -C .. status",
  "git --git-dir=x status",
  "git config core.pager sh",
  "git diff --output=x",
  "git log --output x",
  "git show --output=x HEAD",
  "git diff --ext-diff",
  "git diff --textconv",
  "git symbolic-ref HEAD refs/heads/evil",
  "git symbolic-ref -d HEAD",
  "git symbolic-ref -m msg HEAD refs/x",
  "git branch -d feature",
  "git branch -dr origin/x",
  "git branch -D x",
  "git branch -m a b",
  "git branch --delete x",
  "git branch newname",
  "git branch -f x HEAD",
  "git checkout -f main",
  "git checkout -fb x",
  "git checkout -B main",
  "git worktree frobnicate",
  "git stash",
  "git restore .",
  "git commit -m x",
  "git add .",
  "git init",
  "npm install x",
  "npm exec x",
  "python3 -c 'print(1)'",
  "bash -c 'rm x'",
  "sh -c x",
  "./x.sh",
  "/bin/ls",
  "ls $(id)",
  "ls `id`",
  "ls && rm x",
  "ls; rm x",
  "ls || rm x",
  "ls > out",
  "ls >> out",
  "cat < x",
  "ls 2>&1",
  "ls <(id)",
  "FOO=bar git status",
  "ls\nrm x",
  'echo "unterminated',
  "(ls)",
  "ls &&",
  "echo hi",
];

const ASK = [
  "git push origin feature",
  "git reset --hard",
  "git clean -fd",
  "git checkout -- secrets.env",
  "git checkout -p",
  "git worktree add ../lane",
  "git worktree remove x",
  "git worktree prune",
  "git branch -u origin/x",
  "bash scripts/nexus-branch-cleanup.sh --force-discard x",
];

const ALLOW = [
  "ls",
  "ls -la src",
  "cat README.md",
  "head -5 README.md",
  "wc -l README.md",
  "rg needle src",
  "grep -rn needle src",
  "grep -E 'a|b' file",
  "rg 'a && b' src",
  "find . -name '*.js' -newer package.json",
  "find . -type f -print",
  "git status --short",
  "git diff --stat",
  "git log --oneline -5",
  "git show HEAD --stat",
  "git rev-parse HEAD",
  "git symbolic-ref HEAD",
  "git symbolic-ref --short HEAD",
  "git worktree list",
  "git branch -a",
  "git branch --show-current",
  "git branch --merged main",
  "git checkout -b feature/x",
  "git checkout -b feature/x main",
  "git merge feature/x",
  "npm test",
  "npm run test:unit",
  "npm run build",
  "python3 --version",
  "bash scripts/nexus-branch-cleanup.sh --dry-run",
  "nexus run inspect --run-id x",
  "git log --format='%H %s' -n 3",
];

for (const command of DENY) {
  test(`orchestrator bash denies ${JSON.stringify(command)}`, () => {
    assert.equal(decide(command), "deny");
  });
}

for (const command of ASK) {
  test(`orchestrator bash asks before ${JSON.stringify(command)}`, () => {
    assert.equal(decide(command), "ask");
  });
}

for (const command of ALLOW) {
  test(`orchestrator bash allows read-only or workflow ${JSON.stringify(command)}`, () => {
    assert.equal(decide(command), "allow");
  });
}

test("git checkout of a name is allowed only when it is not a path in the worktree", () => {
  const dir = worktreeWith(["README.md"]);
  try {
    assert.equal(decide("git checkout main", { worktree: dir }), "allow");
    assert.equal(decide("git checkout README.md", { worktree: dir }), "ask");
    assert.equal(decide("git checkout main"), "ask", "without a worktree the target cannot be verified");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a deny anywhere in a compound command denies the whole command", () => {
  assert.equal(decide("git status && git push origin main"), "ask");
  assert.equal(decide("git status && find . -delete"), "deny");
  assert.equal(decide("ls ; sed -i s/a/b/ file"), "deny");
});

test("quoted operators are literal text, not separators", () => {
  assert.equal(decide("rg 'a;b' src"), "allow");
  assert.equal(decide('grep "x|y" file'), "allow");
});

test("the implementer cannot reach Nexus protected state", () => {
  assert.equal(assessImplementerBash("cat ~/.local/state/nexus-control/worktrees/x/runs/r/state.json").ok, false);
  assert.equal(assessImplementerBash("cat /tmp/custom-state/worktrees/x", { env: { NEXUS_STATE_DIR: "/tmp/custom-state" } }).ok, false);
  assert.equal(assessImplementerBash("cat src/app.js", { env: { NEXUS_STATE_DIR: "/tmp/custom-state" } }).ok, true);
  assert.equal(assessImplementerBash("npm test").ok, true);
  assert.equal(assessImplementerBash("ls", { env: { NEXUS_STATE_DIR: "/" } }).ok, true, "a filesystem-root override must not deny every command");
});
