/**
 * Durable verification lifecycle.
 *
 * State transitions authorize movement; this module performs deterministic
 * measurement after a run is already in VERIFYING or FINAL_VERIFYING.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { createDefaultProviders } from "./providers.js";
import {
  sealProviderArtifact,
  sha256Digest,
  stableStringify,
  verifySealedArtifact,
} from "./artifact-seal.js";
import { runStatePath, writeRunState } from "./migrate-artifacts.js";
import { requiresTdd } from "./policy.js";
import { withFileLock } from "./lock.js";

function nowIso() {
  return new Date().toISOString();
}

function gitRevParse(worktree, rev = "HEAD") {
  try {
    const result = spawnSync("git", ["rev-parse", rev], {
      cwd: worktree,
      encoding: "utf8",
    });
    return result.status === 0 ? String(result.stdout || "").trim() || null : null;
  } catch {
    return null;
  }
}

export function verificationArtifactPath(worktree, runId) {
  return path.join(path.dirname(runStatePath(worktree, runId)), "verification.json");
}

function relativeArtifactPath(worktree, file) {
  return path.relative(worktree, file).replace(/\\/g, "/");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function artifactDigest(value) {
  const { artifact_digest: _ignored, ...canonical } = value || {};
  return sha256Digest(stableStringify(canonical));
}

function writeArtifact(file, artifact) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = {
    ...artifact,
    updated_at: nowIso(),
  };
  next.artifact_digest = artifactDigest(next);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, file);
  return next;
}

function phaseForState(state) {
  if (state?.state === "VERIFYING") return "TASK";
  if (state?.state === "FINAL_VERIFYING") return "FINAL";
  return null;
}

function expectedHead(state, phase) {
  if (phase === "TASK") {
    return state.implementer_commit || state.last_implementer_handoff?.commit || null;
  }
  return (
    state.last_final_review_handoff?.reviewed_commit ||
    state.last_review_handoff?.reviewed_commit ||
    state.implementer_commit ||
    null
  );
}

function artifactFieldFor(phase) {
  return phase === "FINAL" ? "final_verification" : "provider_verification";
}

function impactFieldFor(phase) {
  return phase === "FINAL" ? "final_post_impact" : "post_impact";
}

function configurationDigest(phase, timeouts) {
  return sha256Digest(stableStringify({ phase, timeouts }));
}

function riskFromImpact(report, state) {
  return (
    report?.risk ||
    report?.level ||
    state?.impact?.risk ||
    state?.impact?.level ||
    state?.classification?.risk ||
    null
  );
}

function postImpactReport(providers, state, worktree, phase) {
  const analyzed = providers?.impactProvider?.analyze?.({
    worktree,
    base: state.head_commit || state.plan_commit,
    change_class: state.change_class || state.classification?.change_class,
    phase: phase === "FINAL" ? "final-post" : "post",
    post_impact: true,
    force_recompute: true,
  });
  const report = analyzed?.report || analyzed;
  if (
    !report ||
    typeof report !== "object" ||
    analyzed?.ok === false ||
    report.ok === false
  ) {
    return {
      ok: false,
      error: `post-impact provider rejected artifact: ${analyzed?.error || "not ok"}`,
    };
  }
  return { ok: true, report };
}

function discoverPlan(provider, worktree, postImpact, state) {
  const relatedTests = postImpact?.related_tests || state.impact?.related_tests || [];
  const risk = riskFromImpact(postImpact, state);
  const options = {
    worktree,
    related_tests: relatedTests,
    ...(risk ? { risk, risk_tier: risk } : {}),
  };
  const plan = provider.discover(options);
  return { plan, relatedTests, risk, options };
}

function reusableProviderResults(artifact) {
  return (artifact?.steps || []).filter(
    (step) =>
      step?.provider_step === true &&
      step.pass === true &&
      step.status !== "UNAVAILABLE",
  );
}

function countCompleted(artifact) {
  return (artifact.steps || []).filter((step) => step?.status !== "RUNNING").length;
}

function replaceStep(artifact, step) {
  const steps = Array.isArray(artifact.steps) ? [...artifact.steps] : [];
  const index = steps.findIndex((candidate) => candidate?.id === step.id);
  if (index >= 0) steps[index] = step;
  else steps.push(step);
  artifact.steps = steps;
}

function baseArtifact({ runId, phase, head, configDigest, artifactPath }) {
  const startedAt = nowIso();
  return {
    schema_version: "1.0",
    run_id: runId,
    phase,
    status: "RUNNING",
    worktree_head: head,
    started_at: startedAt,
    completed_at: null,
    configuration_digest: configDigest,
    plan_digest: null,
    plan: null,
    post_impact: null,
    tdd_evidence: null,
    steps: [],
    current_step: 0,
    total_steps: 0,
    completed_steps: 0,
    artifact_path: artifactPath,
    failure_reason: null,
  };
}

function statusSummary({
  status,
  phase,
  head,
  artifactPath,
  artifact,
  failureReason = null,
}) {
  return {
    status,
    phase,
    worktree_head: head,
    started_at: artifact.started_at || null,
    completed_at: artifact.completed_at || null,
    plan_digest: artifact.plan_digest || null,
    configuration_digest: artifact.configuration_digest || null,
    artifact_path: artifactPath,
    artifact_digest: artifact.artifact_digest || null,
    current_step: artifact.current_step || 0,
    total_steps: artifact.total_steps || 0,
    completed_steps: artifact.completed_steps || 0,
    failure_reason: failureReason,
  };
}

function persistState(worktree, state, summary, extra = {}) {
  return writeRunState(worktree, {
    ...state,
    ...extra,
    verification_status: summary.status,
    verification: summary,
  });
}

function readBaseline(worktree, state) {
  if (state.baseline && typeof state.baseline === "object") return state.baseline;
  return readJson(path.join(path.dirname(verificationArtifactPath(worktree, state.run_id)), "baseline.json"));
}

function hasExecutedVerificationCheck(run) {
  return (run?.results || []).some(
    (result) =>
      result &&
      result.status !== "UNAVAILABLE" &&
      (result.exit_code != null || result.timed_out === true || result.status === "REUSED"),
  );
}

function canReuseArtifact(artifact, {
  phase,
  head,
  configDigest,
  runId,
  summaryDigest = null,
}) {
  const suppliedDigest = artifact?.artifact_digest;
  const digestMatches =
    typeof suppliedDigest === "string" && suppliedDigest === artifactDigest(artifact);
  return (
    artifact &&
    artifact.run_id === runId &&
    artifact.phase === phase &&
    artifact.worktree_head === head &&
    artifact.configuration_digest === configDigest &&
    (!summaryDigest || summaryDigest === suppliedDigest) &&
    digestMatches &&
    artifact.post_impact?.worktree_head === head &&
    artifact.post_impact?.ok !== false &&
    verifySealedArtifact(artifact.post_impact)
  );
}

/**
 * Run (or safely resume) verification for an already-authorized active run.
 * `onProgress` receives durable progress events after every state write.
 */
function runVerificationLifecycleUnlocked({
  worktree,
  state,
  providers = null,
  resume = false,
  onProgress = null,
} = {}) {
  const phase = phaseForState(state);
  if (!phase) {
    return {
      ok: false,
      code: "INVALID_VERIFICATION_STATE",
      error: "nexus verify requires an active run in VERIFYING or FINAL_VERIFYING",
      state,
    };
  }
  const root = worktree || process.cwd();
  const activeProviders = providers || createDefaultProviders({ worktree: root });
  const provider = activeProviders.verificationProvider;
  const head = gitRevParse(root, "HEAD");
  const expected = expectedHead(state, phase);
  const artifactFile = verificationArtifactPath(root, state.run_id);
  const artifactPath = relativeArtifactPath(root, artifactFile);
  const needsTdd = phase === "TASK" && requiresTdd(state);
  const timeouts = provider?.resolveTimeouts
    ? provider.resolveTimeouts(root)
    : (awaitableTimeouts(provider, root));
  const configDigest = configurationDigest(phase, timeouts);

  // The handoff/review binding checked by the fast transition must still hold
  // when measurement begins. Never verify a different commit under old state.
  if (!head || !expected || head !== expected) {
    let artifact = baseArtifact({
      runId: state.run_id,
      phase,
      head,
      configDigest,
      artifactPath,
    });
    artifact.status = "FAILED";
    artifact.completed_at = nowIso();
    artifact.failure_reason = "HEAD_MISMATCH";
    artifact = writeArtifact(artifactFile, artifact);
    const summary = statusSummary({
      status: "FAILED",
      phase,
      head,
      artifactPath,
      artifact,
      failureReason: "HEAD_MISMATCH",
    });
    const persisted = persistState(root, state, summary);
    return {
      ok: false,
      code: "HEAD_MISMATCH",
      error: `current HEAD ${head || "unavailable"} does not match expected verification commit ${expected || "missing"}`,
      state: persisted,
      artifact,
    };
  }

  const prior = resume ? readJson(artifactFile) : null;
  let artifact = baseArtifact({
    runId: state.run_id,
    phase,
    head,
    configDigest,
    artifactPath,
  });
  let reusable = false;
  let postImpact = null;
  let planInfo = null;

  if (
    canReuseArtifact(prior, {
      phase,
      head,
      configDigest,
      runId: state.run_id,
      summaryDigest: state.verification?.artifact_digest || null,
    })
  ) {
    try {
      const candidate = discoverPlan(provider, root, prior.post_impact, state);
      const candidateDigest = sha256Digest(stableStringify(candidate.plan));
      if (prior.plan_digest === candidateDigest) {
        reusable = true;
        postImpact = prior.post_impact;
        planInfo = candidate;
        artifact = {
          ...prior,
          status: "RUNNING",
          completed_at: null,
          failure_reason: null,
          artifact_path: artifactPath,
        };
      }
    } catch {
      // A changed/broken plan resolver is not a safe resume identity. Start
      // fresh below and record its error through the normal lifecycle path.
    }
  }

  // Persist RUNNING before any potentially long process. An interruption now
  // leaves a clear resume target instead of returning the run to IMPLEMENTING.
  artifact = writeArtifact(artifactFile, artifact);
  let currentState = persistState(
    root,
    state,
    statusSummary({
      status: "RUNNING",
      phase,
      head,
      artifactPath,
      artifact,
    }),
  );
  onProgress?.({ type: "run_start", phase, head, resumed: reusable });

  const update = ({ status = "RUNNING", failureReason = null } = {}) => {
    artifact.status = status;
    artifact.completed_steps = countCompleted(artifact);
    if (status !== "RUNNING") artifact.completed_at = nowIso();
    artifact.failure_reason = failureReason;
    artifact = writeArtifact(artifactFile, artifact);
    currentState = persistState(
      root,
      currentState,
      statusSummary({
        status,
        phase,
        head,
        artifactPath,
        artifact,
        failureReason,
      }),
      status === "PASSED" && phase === "TASK" ? { require_post_impact: false } : {},
    );
  };

  const fail = (code, error, status = "FAILED") => {
    update({ status, failureReason: code });
    onProgress?.({ type: "run_complete", ok: false, status, code, error });
    return { ok: false, code, error, state: currentState, artifact };
  };

  if (!reusable) {
    onProgress?.({ type: "step_start", index: 1, total: null, step: { id: "post-impact" } });
    artifact.current_step = 1;
    update();
    let measured;
    try {
      measured = postImpactReport(activeProviders, currentState, root, phase);
    } catch (error) {
      return fail("POST_IMPACT_FAILED", String(error?.message || error));
    }
    if (!measured.ok) return fail("POST_IMPACT_FAILED", measured.error);
    postImpact = sealProviderArtifact(measured.report, head);
    replaceStep(artifact, {
      id: "post-impact",
      kind: "impact",
      pass: true,
      status: "PASSED",
      provider_step: false,
      worktree_head: head,
    });
    artifact.post_impact = postImpact;
    try {
      planInfo = discoverPlan(provider, root, postImpact, currentState);
    } catch (error) {
      return fail("PLAN_DISCOVERY_FAILED", String(error?.message || error));
    }
    artifact.plan = planInfo.plan;
    artifact.plan_digest = sha256Digest(stableStringify(planInfo.plan));
    artifact.total_steps =
      1 + (needsTdd ? 1 : 0) + (planInfo.plan.steps || []).length;
    update();
    onProgress?.({
      type: "step_complete",
      index: 1,
      total: artifact.total_steps,
      step: { id: "post-impact" },
      result: artifact.steps.find((step) => step.id === "post-impact"),
    });
  } else {
    artifact.plan = planInfo.plan;
    artifact.plan_digest = sha256Digest(stableStringify(planInfo.plan));
    artifact.total_steps =
      1 + (needsTdd ? 1 : 0) + (planInfo.plan.steps || []).length;
    update();
    onProgress?.({
      type: "step_reused",
      index: 1,
      total: artifact.total_steps,
      step: { id: "post-impact" },
      result: artifact.steps.find((step) => step.id === "post-impact"),
    });
  }

  const impactField = impactFieldFor(phase);
  currentState = persistState(root, currentState, currentState.verification, {
    [impactField]: postImpact,
  });
  onProgress?.({
    type: "plan_ready",
    phase,
    risk: planInfo.risk || "UNKNOWN",
    total: artifact.total_steps,
    executable_steps: (planInfo.plan.steps || []).filter(
      (step) => step?.status !== "UNAVAILABLE" && step?.command,
    ).length,
  });

  let tddEvidence = null;
  const tddIndex = 2;
  const priorTdd =
    reusable &&
    verifySealedArtifact(artifact.tdd_evidence) &&
    artifact.tdd_evidence.ok === true &&
    artifact.tdd_evidence.worktree_head === head;
  if (needsTdd) {
    if (priorTdd) {
      tddEvidence = artifact.tdd_evidence;
      onProgress?.({
        type: "step_reused",
        index: tddIndex,
        total: artifact.total_steps,
        step: { id: "tdd" },
        result: artifact.steps.find((step) => step.id === "tdd"),
      });
    } else {
      onProgress?.({ type: "step_start", index: tddIndex, total: artifact.total_steps, step: { id: "tdd" } });
      artifact.current_step = tddIndex;
      update();
      const handoff = currentState.last_implementer_handoff || {};
      try {
        tddEvidence = provider.verifyTdd({
          worktree: root,
          base_commit: handoff.base_commit || currentState.head_commit,
          implementer_commit: handoff.commit || currentState.implementer_commit || head,
          related_tests: planInfo.relatedTests,
          plan: planInfo.plan,
          timeout_ms: timeouts.fullTest,
        });
      } catch (error) {
        return fail("TDD_FAILED", String(error?.message || error));
      }
      const timedOut = tddEvidence?.timed_out === true;
      replaceStep(artifact, {
        id: "tdd",
        kind: "tdd",
        pass: tddEvidence?.ok === true,
        status: timedOut ? "TIMED_OUT" : tddEvidence?.ok === true ? "PASSED" : "FAILED",
        provider_step: false,
        timed_out: timedOut,
      });
      artifact.tdd_evidence = tddEvidence || null;
      update();
      onProgress?.({
        type: "step_complete",
        index: tddIndex,
        total: artifact.total_steps,
        step: { id: "tdd" },
        result: artifact.steps.find((step) => step.id === "tdd"),
      });
      if (!tddEvidence?.ok) {
        return fail(timedOut ? "TDD_TIMED_OUT" : "TDD_FAILED", "TDD verification did not pass", timedOut ? "TIMED_OUT" : "FAILED");
      }
    }
    currentState = persistState(root, currentState, currentState.verification, {
      tdd_evidence: tddEvidence,
    });
  }

  const providerOffset = needsTdd ? 2 : 1;
  let providerRun;
  try {
    providerRun = provider.run({
      worktree: root,
      related_tests: planInfo.relatedTests,
      risk: planInfo.risk,
      risk_tier: planInfo.risk,
      plan: planInfo.plan,
      reuse_results: reusable ? reusableProviderResults(artifact) : [],
      onProgress(event) {
        const index = providerOffset + event.index;
        if (event.type === "start") {
          artifact.current_step = index;
          update();
          onProgress?.({ type: "step_start", index, total: artifact.total_steps, step: event.step });
          return;
        }
        const result = {
          ...(event.result || {}),
          provider_step: true,
        };
        replaceStep(artifact, result);
        artifact.current_step = index;
        update();
        onProgress?.({
          type: event.type === "reuse" ? "step_reused" : "step_complete",
          index,
          total: artifact.total_steps,
          step: event.step,
          result,
        });
      },
    });
  } catch (error) {
    return fail("VERIFICATION_PROVIDER_ERROR", String(error?.message || error));
  }

  const baseline = readBaseline(root, currentState);
  let baselineComparison = null;
  let ok = providerRun?.ok === true && hasExecutedVerificationCheck(providerRun);
  if (baseline && provider.compare) {
    baselineComparison = provider.compare(baseline, providerRun);
    if (baselineComparison.ok !== true) {
      ok = false;
    } else if (!providerRun?.timed_out && hasExecutedVerificationCheck(providerRun)) {
      // Baselines can waive only known prior failures, never a timeout or an
      // unavailable measurement.
      ok = true;
    }
  }

  const verificationArtifact = sealProviderArtifact(
    {
      schema_version: "1.0",
      ok,
      results: providerRun?.results || [],
      plan: providerRun?.plan || planInfo.plan,
      source: "verification-provider",
      baseline_comparison: baselineComparison,
      plan_digest: artifact.plan_digest,
      configuration_digest: configDigest,
      timed_out: providerRun?.timed_out === true,
    },
    head,
  );
  artifact[artifactFieldFor(phase)] = verificationArtifact;
  const verificationField = artifactFieldFor(phase);
  currentState = persistState(root, currentState, currentState.verification, {
    [verificationField]: verificationArtifact,
  });

  if (providerRun?.timed_out) {
    return fail("VERIFICATION_TIMED_OUT", "verification timed out", "TIMED_OUT");
  }
  if (!ok) {
    return fail(
      providerRun?.code || "VERIFICATION_FAILED",
      providerRun?.code === "VERIFICATION_UNAVAILABLE"
        ? "zero executable verification checks"
        : "verification checks failed",
    );
  }

  update({ status: "PASSED" });
  onProgress?.({ type: "run_complete", ok: true, status: "PASSED", artifact: verificationArtifact });
  return {
    ok: true,
    state: currentState,
    artifact,
    verification: verificationArtifact,
    phase,
  };
}

// Kept as a tiny indirection so injected providers can expose their own
// resolver without forcing a new provider interface on existing integrations.
function awaitableTimeouts(provider, worktree) {
  if (provider?.timeouts && typeof provider.timeouts === "object") return provider.timeouts;
  // `run()` always resolves these defaults internally. Import lazily here would
  // add no value, so mirror the documented defaults for the state identity.
  return {
    targetedTest: 300000,
    fullTest: 900000,
    lint: 300000,
    typecheck: 600000,
    build: 900000,
  };
}

/**
 * Serialize a run's measurement so two `nexus verify` invocations cannot
 * overwrite each other's artifact/progress state. The lock records its owner
 * PID; `withFileLock` reaps it promptly after a crashed process but never
 * treats a long-running live verification as stale.
 */
export function runVerificationLifecycle(args = {}) {
  const phase = phaseForState(args.state);
  if (!phase) return runVerificationLifecycleUnlocked(args);
  const root = args.worktree || process.cwd();
  const file = verificationArtifactPath(root, args.state.run_id);
  try {
    return withFileLock(
      file,
      () => runVerificationLifecycleUnlocked(args),
      { retries: 1, staleMs: 10_000 },
    );
  } catch (error) {
    if (!String(error?.message || error).startsWith("could not acquire lock:")) {
      throw error;
    }
    return {
      ok: false,
      code: "VERIFICATION_IN_PROGRESS",
      error: `verification is already running for ${args.state.run_id}: ${String(error?.message || error)}`,
      state: args.state,
      phase,
    };
  }
}
