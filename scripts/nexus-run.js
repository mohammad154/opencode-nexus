#!/usr/bin/env node
/**
 * Nexus workflow run CLI
 *
 * Exit codes: 0 ok, 2 validation failure, 3 illegal transition
 *
 * Commands:
 *   init --run-id <id>
 *   classify [--input file|--json '{}'] [classifier flags...]
 *   transition --to STATE [--evidence path] [--json '{}']
 *   validate-handoff --role ROLE --file path
 *   status [--run-id id]
 *   resume [--run-id id]
 */
import fs from "fs";
import path from "path";
import {
  createEmptyRunState,
  writeRunState,
  readRunState,
  latestRunState,
  inferRunFromContext,
  normalizeAndValidateHandoff,
} from "./lib/migrate-artifacts.js";
import { classify, loadWorkflowConfig } from "./lib/classify.js";
import {
  transition as smTransition,
  canTransition,
} from "./lib/state-machine.js";
import { createDefaultProviders } from "./lib/providers.js";
import { assessDrift } from "./lib/drift.js";
import { assertValidRunId } from "./lib/policy.js";

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out.flags[key] = true;
    else {
      out.flags[key] = next;
      i++;
    }
  }
  return out;
}

function worktree() {
  return process.env.NEXUS_WORKTREE || process.cwd();
}

function loadEvidence(flags) {
  let evidence = {};
  if (flags.evidence) {
    const p = flags.evidence;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    evidence = { ...raw, evidence_path: p };
  }
  if (flags.json) {
    evidence = { ...evidence, ...JSON.parse(flags.json) };
  }
  if (flags.classification) {
    evidence.classification = JSON.parse(
      fs.readFileSync(flags.classification, "utf8"),
    );
  }
  if (flags["handoff-file"]) {
    evidence.implementer_handoff = JSON.parse(
      fs.readFileSync(flags["handoff-file"], "utf8"),
    );
  }
  if (flags["unified-handoff"]) {
    evidence.unified_handoff = JSON.parse(
      fs.readFileSync(flags["unified-handoff"], "utf8"),
    );
  }
  if (flags["spec-handoff"]) {
    evidence.spec_handoff = JSON.parse(
      fs.readFileSync(flags["spec-handoff"], "utf8"),
    );
  }
  if (flags["code-handoff"]) {
    evidence.code_handoff = JSON.parse(
      fs.readFileSync(flags["code-handoff"], "utf8"),
    );
  }
  if (flags.branch) evidence.branch = flags.branch;
  if (flags["plan-skip"]) evidence.plan_skip = true;
  if (flags["acceptance"]) {
    evidence.acceptance_criteria = String(flags.acceptance)
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (flags.blast) {
    evidence.blast = JSON.parse(fs.readFileSync(flags.blast, "utf8"));
  }
  if (flags.graph) {
    evidence.graph = JSON.parse(fs.readFileSync(flags.graph, "utf8"));
  }
  evidence.worktree = worktree();
  return evidence;
}

function resolveRun(flags) {
  const wt = worktree();
  if (flags["run-id"]) {
    const s = readRunState(wt, flags["run-id"]);
    if (!s) {
      console.error(
        JSON.stringify({
          ok: false,
          error: `run not found: ${flags["run-id"]}`,
        }),
      );
      process.exit(2);
    }
    return s;
  }
  const latest = latestRunState(wt);
  if (latest) return latest;
  return null;
}

function cmdInit(flags) {
  const id = flags["run-id"] || `run-${new Date().toISOString().slice(0, 10)}`;
  assertValidRunId(id);
  const state = createEmptyRunState(id, {
    profile: flags.profile || "balanced",
  });
  writeRunState(worktree(), state);
  console.log(JSON.stringify({ ok: true, state }, null, 2));
}

function cmdClassify(flags) {
  let input = {};
  if (flags.input) input = JSON.parse(fs.readFileSync(flags.input, "utf8"));
  if (flags.json) input = { ...input, ...JSON.parse(flags.json) };
  if (flags.files) input.filesChanged = Number(flags.files);
  if (flags.lines) input.estimatedLines = Number(flags.lines);
  if (flags.class) input.changeClass = flags.class;
  if (flags.focused) input.focusedValidation = true;
  if (flags.docs) input.documentationOnly = true;
  if (flags.security) input.securitySensitive = true;
  if (flags["public-api"]) input.publicApi = true;
  if (flags.profile) input.profileOverride = flags.profile;

  const result = classify(input, { workflowConfig: loadWorkflowConfig() });
  let state = resolveRun(flags);
  if (state && flags.apply) {
    const r = smTransition(state, "CLASSIFIED", { classification: result });
    if (!r.ok) {
      console.error(
        JSON.stringify(
          { ok: false, errors: r.errors, classification: result },
          null,
          2,
        ),
      );
      process.exit(3);
    }
    writeRunState(worktree(), r.state);
    console.log(
      JSON.stringify(
        { ok: true, classification: result, state: r.state },
        null,
        2,
      ),
    );
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function cmdTransition(flags) {
  const to = flags.to;
  if (!to) {
    console.error(JSON.stringify({ ok: false, error: "--to required" }));
    process.exit(2);
  }
  let state = resolveRun(flags);
  if (!state) {
    console.error(
      JSON.stringify({ ok: false, error: "no run state; run init first" }),
    );
    process.exit(2);
  }
  const evidence = loadEvidence(flags);
  const providers = createDefaultProviders();

  // Auto-fill graph/blast via providers when transitioning to those states
  if (to === "GRAPH_READY" && !evidence.graph) {
    evidence.graph = providers.graphProvider.build({
      worktree: worktree(),
      force: !!flags.force,
    });
  }
  if (to === "BLAST_READY" && !evidence.blast) {
    const analyzed = providers.blastProvider.analyze({
      worktree: worktree(),
      reportPath: flags["blast-path"],
      mermaid: !!flags.mermaid,
    });
    evidence.blast = analyzed.ok ? analyzed.report : analyzed;
  }

  const r = smTransition(state, to, evidence, providers);
  if (!r.ok) {
    console.error(JSON.stringify({ ok: false, errors: r.errors }, null, 2));
    process.exit(3);
  }
  writeRunState(worktree(), r.state);
  console.log(JSON.stringify({ ok: true, state: r.state }, null, 2));
}

function cmdValidateHandoff(flags) {
  const role = flags.role;
  const file = flags.file;
  if (!role || !file) {
    console.error(
      JSON.stringify({ ok: false, error: "--role and --file required" }),
    );
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const result = normalizeAndValidateHandoff(role, raw);
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(2);
  }
  if (flags.write) {
    fs.writeFileSync(file, JSON.stringify(result.data, null, 2) + "\n");
  }
  console.log(
    JSON.stringify(
      { ok: true, migrated_from: result.migrated_from, data: result.data },
      null,
      2,
    ),
  );
}

function cmdStatus(flags) {
  const state = resolveRun(flags);
  if (!state) {
    const inferred = inferRunFromContext(worktree());
    console.log(
      JSON.stringify({ ok: true, inferred: true, state: inferred }, null, 2),
    );
    return;
  }
  console.log(JSON.stringify({ ok: true, state }, null, 2));
}

function cmdResume(flags) {
  let state = resolveRun(flags);
  if (!state) {
    state = inferRunFromContext(worktree());
    // Persist synthesized run so resume is durable
    const { _inferred, ...rest } = state;
    writeRunState(worktree(), rest);
    console.log(
      JSON.stringify(
        {
          ok: true,
          resumed: true,
          inferred: true,
          state: rest,
          note: "synthesized from CONTEXT; did not invent approvals",
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        resumed: true,
        state,
        next_hint:
          state.state === "COMPLETED"
            ? "already complete"
            : `continue from ${state.state}`,
      },
      null,
      2,
    ),
  );
}

function cmdDrift(flags) {
  let input = {};
  if (flags.input) input = JSON.parse(fs.readFileSync(flags.input, "utf8"));
  if (flags.json) input = { ...input, ...JSON.parse(flags.json) };
  input.worktree = worktree();
  if (flags["plan-commit"]) input.plan_commit = flags["plan-commit"];
  if (flags["commit-distance"])
    input.commit_distance = Number(flags["commit-distance"]);
  const report = assessDrift(input);
  console.log(JSON.stringify(report, null, 2));
  if (report.drift === "HIGH") process.exit(2);
}

function cmdCan(flags) {
  const to = flags.to;
  const state = resolveRun(flags);
  if (!state || !to) {
    console.error(
      JSON.stringify({ ok: false, error: "need run state and --to" }),
    );
    process.exit(2);
  }
  const evidence = loadEvidence(flags);
  const r = canTransition(state, to, evidence);
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(3);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const flags = args.flags;
  try {
    switch (cmd) {
      case "init":
        return cmdInit(flags);
      case "classify":
        return cmdClassify(flags);
      case "transition":
        return cmdTransition(flags);
      case "validate-handoff":
        return cmdValidateHandoff(flags);
      case "status":
        return cmdStatus(flags);
      case "resume":
        return cmdResume(flags);
      case "drift":
        return cmdDrift(flags);
      case "can-transition":
        return cmdCan(flags);
      default:
        console.error(
          `Unknown or missing command. Use: init|classify|transition|validate-handoff|status|resume|drift|can-transition`,
        );
        process.exit(2);
    }
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exit(2);
  }
}

main();
