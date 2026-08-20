# Graph Report - opencode-nexus  (2026-08-20)

## Corpus Check
- 133 files · ~68,778 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1674 nodes · 2436 edges · 154 communities (133 shown, 21 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.54)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `844fcfbd`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- graphify.js
- providers.js
- classify.js
- package.json
- properties
- properties
- Orchestrating (V4 — evidence-driven)
- analyze.js
- state-machine.js
- ensure-cli-on-path.js
- schema_version
- properties
- required
- null
- properties
- properties
- verification-and-dag.test.js
- required
- properties
- bin/nexus.js
- OpenCode Nexus
- enum
- properties
- Blast Radius (CodeLookup-inspired pre-implementation safety check)
- properties
- type
- properties
- nexus-estimate-calls.js
- Procedure
- type
- properties
- classification-evidence.schema.json
- run-state.schema.json
- nexus-run.js
- graphify-adapter.test.js
- properties
- properties
- properties
- Finishing a Development Branch (V3 – profiles + script cleanup)
- Outcome Memory — LESSONS.md (V3)
- Using Feature Branches (V3)
- createDefaultProviders
- properties
- enum
- null
- tdd
- impact-report.schema.json
- enum
- properties
- required
- items
- properties
- required
- required
- run_id
- test-adapter-contract.sh
- Writing Plans (improve-grade)
- items
- blast-report.schema.json
- properties
- null
- items
- security
- drift
- items
- type
- cli-flow.test.js
- enum
- reasons
- type
- enum
- handoff-code-reviewer.schema.json
- enum
- handoff-unified-reviewer.schema.json
- blast
- enum
- properties
- test-install-only.sh
- blast-output.test.js
- enum
- enum
- enum
- enum
- enum
- enum
- test-optional-agents.sh
- install.sh
- policy.js
- drift_check
- stage
- enum
- enum
- handoff-spec-reviewer.schema.json
- nexus-branch-cleanup.sh
- Integration Reviewer
- enum
- unsupported_fields
- schema_version
- schema_version
- schema_version
- schema_version
- schema_version
- calls.test.js
- worktree.js
- dimensions
- nexus-blast.js
- run-init.test.js
- Diagnostician
- gate-hardening.test.js
- agent
- created_at
- run_id
- confidence
- Branch Cleanup (V3 — script-first)
- Unified Reviewer Dispatch Template (V3 — combined spec + quality)
- uninstall.sh
- install-git-hook.sh
- nexus-blast.sh script
- brainstorming/SKILL.md
- code-reviewer-prompt.md
- Implementer Dispatch Template (V4 — TDD + scope lock + impact)
- spec-reviewer-prompt.md
- blast-analyzer.md
- orchestrator.md
- test-uninstall-lifecycle.sh
- reasons
- agent
- unit_or_task
- analysis_quality
- changed_symbols
- ok
- provider_validated
- schema_version
- trusted
- updated_at
- impact-analysis/SKILL.md
- v3-golden-flows.js
- schema-validate.js
- verifySealedArtifact
- createMetricsTelemetry
- boolean
- drift.js
- template-gate-contract.test.js
- created_at

## God Nodes (most connected - your core abstractions)
1. `classify()` - 27 edges
2. `canTransition()` - 27 edges
3. `reclassifyAfterBlast()` - 17 edges
4. `collectGitDiffEvidence()` - 17 edges
5. `analyzeImpact()` - 17 edges
6. `transition()` - 15 edges
7. `NexusPlugin()` - 14 edges
8. `createDefaultProviders()` - 14 edges
9. `OpenCode Nexus` - 14 edges
10. `enum` - 13 edges

## Surprising Connections (you probably didn't know these)
- `collectFlags()` --indirect_call--> `flag()`  [INFERRED]
  scripts/lib/classify.js → scripts/nexus-estimate-calls.js
- `buildGateInjection()` --calls--> `buildRunGateReminder()`  [EXTRACTED]
  .opencode/plugins/nexus.js → scripts/lib/run-gate.js
- `NexusPlugin()` --calls--> `buildRunGateReminder()`  [EXTRACTED]
  .opencode/plugins/nexus.js → scripts/lib/run-gate.js
- `cmdProjectInit()` --calls--> `projectInit()`  [EXTRACTED]
  bin/nexus.js → scripts/lib/project-init.js
- `sealedImpact()` --calls--> `sealImpactArtifact()`  [EXTRACTED]
  tests/helpers/gate-fixtures.js → scripts/lib/state-machine.js

## Import Cycles
- None detected.

## Communities (154 total, 21 thin omitted)

### Community 0 - "graphify.js"
Cohesion: 0.22
Nodes (17): asObject(), currentHead(), edgeEndpoint(), GRAPHIFY_RELATION_SET, GRAPHIFY_RELATIONS, graphRootFromOutput(), manifestSourcePath(), mapFilesToGraphifyNodes() (+9 more)

### Community 1 - "providers.js"
Cohesion: 0.09
Nodes (23): annotateGraphifyBlastReport(), BLAST_PROVIDER_METADATA, collectFileValues(), collectRawFileValues(), createGraphifyBlastProvider(), createGraphifyGraphProvider(), createLiteBlastProvider(), createLiteGraphProvider() (+15 more)

### Community 2 - "classify.js"
Cohesion: 0.05
Nodes (76): addWeighted(), allFilesAreTestsOrDocs(), applyConfidenceGates(), applyPathSignalRules(), asObject(), assessEvidenceQuality(), blastRiskOf(), CLASS_FLAGS (+68 more)

### Community 3 - "package.json"
Cohesion: 0.04
Nodes (45): bin, nexus, opencode-nexus, bugs, url, description, engines, node (+37 more)

### Community 4 - "properties"
Cohesion: 0.06
Nodes (38): drift, additionalProperties, items, type, type, type, enum, type (+30 more)

### Community 5 - "properties"
Cohesion: 0.05
Nodes (38): additionalProperties, minLength, type, type, minLength, type, description, $id (+30 more)

### Community 6 - "Orchestrating (V4 — evidence-driven)"
Cohesion: 0.06
Nodes (33): Anti-patterns, Dual review (strict, or high-risk under any profile), Fix loops, Resolve the local agent name, Review gates by profile, Skip review (documentation-only under fast), Subagent Dispatch (OpenCode) — V3 profiles, Unified review (fast/balanced, low–medium risk) (+25 more)

### Community 7 - "analyze.js"
Cohesion: 0.09
Nodes (40): adapterSupports(), extractJsSymbols(), extractSymbols(), JS_EXTS, languageForPath(), analyzeImpact(), normalizePlannedTargets(), computeConfidence() (+32 more)

### Community 8 - "state-machine.js"
Cohesion: 0.15
Nodes (26): hasExplicitBlastVerification(), hasExplicitImpactVerification(), requiresTdd(), assertPostImpactEvidence(), assertProviderVerification(), assertVerificationGates(), bindImplementerHandoffErrors(), bindReviewerHandoffErrors() (+18 more)

### Community 9 - "ensure-cli-on-path.js"
Cohesion: 0.17
Nodes (19): BIN_NAMES, ensureUserBinOnPath(), isGlobalInstall(), isOurShim(), isTruthy(), pathHasDir(), pkg, pkgRoot (+11 more)

### Community 10 - "schema_version"
Cohesion: 0.50
Nodes (4): 1.0, schema_version, enum, type

### Community 11 - "properties"
Cohesion: 0.09
Nodes (23): type, type, type, type, type, type, type, properties (+15 more)

### Community 12 - "required"
Cohesion: 0.06
Nodes (34): CHANGES_REQUESTED, additionalProperties, type, allOf, type, $id, 1.1, agent (+26 more)

### Community 13 - "null"
Cohesion: 0.19
Nodes (15): type, type, type, properties, null, string, type, type (+7 more)

### Community 14 - "properties"
Cohesion: 0.10
Nodes (21): minLength, type, minLength, type, type, type, properties, agent (+13 more)

### Community 15 - "properties"
Cohesion: 0.11
Nodes (19): minLength, type, minLength, type, type, properties, agent, created_at (+11 more)

### Community 16 - "verification-and-dag.test.js"
Cohesion: 0.16
Nodes (19): globsOverlap(), globToRegExp(), normalizeAllowedFiles(), pathMatchesGlob(), scopeExpansionNeeded(), canSelfApprove(), fixLoopDecision(), normalizeFinding() (+11 more)

### Community 17 - "required"
Cohesion: 0.11
Nodes (17): commit, drift_check, status, verification_gates, additionalProperties, allOf, $id, agent (+9 more)

### Community 18 - "properties"
Cohesion: 0.08
Nodes (25): results, additionalProperties, type, type, type, type, $id, null (+17 more)

### Community 19 - "bin/nexus.js"
Cohesion: 0.06
Nodes (46): cmdBlast(), cmdClassify(), cmdEstimate(), cmdImpact(), cmdProjectInit(), cmdRun(), [command, ...args], doctor() (+38 more)

### Community 20 - "OpenCode Nexus"
Cohesion: 0.04
Nodes (44): Agent roster, Impact Engine (replaces Graphify/blast), Inspect, Isolation, Lifecycle, Nexus V4 workflow, Review, TDD (+36 more)

### Community 21 - "enum"
Cohesion: 0.13
Nodes (15): CLASSIFIED, COMPLETED, CREATED, DIRECT_IMPLEMENTING, FAILED, FINAL_VERIFYING, IMPACT_READY, IMPLEMENTING (+7 more)

### Community 22 - "properties"
Cohesion: 0.13
Nodes (15): type, type, type, type, type, properties, blast_risk, change_class (+7 more)

### Community 23 - "Blast Radius (CodeLookup-inspired pre-implementation safety check)"
Cohesion: 0.13
Nodes (14): Artifacts (when --task N), Blast Radius (CodeLookup-inspired pre-implementation safety check), Commands, Hard rules, How Graphify improves blast, Human markdown (default), Integration points, JSON (via --json or after markdown separated by ---JSON--- marker) (+6 more)

### Community 24 - "properties"
Cohesion: 0.12
Nodes (17): type, type, properties, legacy_unverified, lessons_checked, role, run_id, task_id (+9 more)

### Community 25 - "type"
Cohesion: 0.14
Nodes (14): items, type, type, object, files_changed, scope_extras, tasks_completed, tests (+6 more)

### Community 26 - "properties"
Cohesion: 0.11
Nodes (29): additionalProperties, type, type, type, type, additionalProperties, type, type (+21 more)

### Community 27 - "nexus-estimate-calls.js"
Cohesion: 0.15
Nodes (14): args, breakdownFor(), callsForUnit(), changeClass, chosen, DUAL_REVIEW_CLASSES, estimate(), executionMode (+6 more)

### Community 28 - "Procedure"
Cohesion: 0.14
Nodes (13): Pre-requisites, Procedure, Reconcile, Reference: shadcn/improve reconcile contract borrowed, Step 0 — Read state, Step 1 — Drift check (semantic primary, commit distance secondary), Step 2 — Verify DONE tasks still hold, Step 3 — Investigate BLOCKED / NEEDS_CONTEXT tasks (+5 more)

### Community 29 - "type"
Cohesion: 0.15
Nodes (13): items, type, items, type, type, affected_packages, hard_triggers, semantic_signals (+5 more)

### Community 30 - "properties"
Cohesion: 0.11
Nodes (19): type, type, type, type, type, properties, affected_packages, analysis_complete (+11 more)

### Community 31 - "classification-evidence.schema.json"
Cohesion: 0.17
Nodes (11): risk_score, additionalProperties, $id, confidence, profile, reasons, schema_version, required (+3 more)

### Community 32 - "run-state.schema.json"
Cohesion: 0.17
Nodes (11): state, transitions, additionalProperties, $id, profile, run_id, schema_version, required (+3 more)

### Community 33 - "nexus-run.js"
Cohesion: 0.09
Nodes (44): createEmptyRunState(), deepClone(), inferRunFromContext(), isLegacyHandoffVersion(), latestRunState(), LEGACY_HANDOFF_VERSIONS, listRunIds(), normalizeHandoff() (+36 more)

### Community 34 - "graphify-adapter.test.js"
Cohesion: 0.20
Nodes (7): isCanonicalGraphifyGraphPath(), prepareGraphifyGraph(), readGraphifyGraph(), refreshGraphifyGraph(), resolveGraphifyGraphPath(), resolveGraphifyOut(), __dirname

### Community 35 - "properties"
Cohesion: 0.18
Nodes (11): additionalProperties, properties, type, boolean, type, blast, pass, regression_risk (+3 more)

### Community 36 - "properties"
Cohesion: 0.18
Nodes (11): type, additionalProperties, properties, type, items, type, artifact_digest, blast (+3 more)

### Community 37 - "properties"
Cohesion: 0.18
Nodes (11): type, type, additionalProperties, properties, actual, cmd, expected, id (+3 more)

### Community 38 - "Finishing a Development Branch (V3 – profiles + script cleanup)"
Cohesion: 0.18
Nodes (10): Branch cleanup note, Checkpoint scope, Detect the base branch, Disposition values, Finishing a Development Branch (V3 – profiles + script cleanup), `merge_policy: always_to_base` (default), `merge_policy: prompt` (opt-in only), Outcome memory (+2 more)

### Community 39 - "Outcome Memory — LESSONS.md (V3)"
Cohesion: 0.18
Nodes (10): Entry template, Hard rules, Integration, lessonPolicy, Noteworthy-only write criteria, Outcome Memory — LESSONS.md (V3), Purpose, Reflect / compact (+2 more)

### Community 40 - "Using Feature Branches (V3)"
Cohesion: 0.18
Nodes (10): Branch policy (profile-aware), Cleanup, Detect the base branch, `isolated` (default for strict), Isolation recovery, Merge policy (project default), `per-feature` (default for balanced/fast), Prerequisites (+2 more)

### Community 41 - "createDefaultProviders"
Cohesion: 0.19
Nodes (13): createDefaultProviders(), createEditValidator(), createLessonsMemory(), createUnsupportedProvider(), getBlastProvider(), getEditValidator(), getGraphProvider(), createMemoryProvider() (+5 more)

### Community 42 - "properties"
Cohesion: 0.24
Nodes (10): number, type, additionalProperties, properties, type, null, direct_callers, graphify (+2 more)

### Community 43 - "enum"
Cohesion: 0.27
Nodes (10): enum, type, HIGH, LOW, MEDIUM, UNKNOWN, computed_risk, risk (+2 more)

### Community 44 - "null"
Cohesion: 0.24
Nodes (10): type, boolean, null, string, type, type, base_commit, plan_commit (+2 more)

### Community 45 - "tdd"
Cohesion: 0.16
Nodes (14): type, type, properties, type, command, exit_code, green, red (+6 more)

### Community 46 - "impact-report.schema.json"
Cohesion: 0.20
Nodes (9): additionalProperties, $id, confidence, risk, schema_version, required, $schema, title (+1 more)

### Community 47 - "enum"
Cohesion: 0.25
Nodes (8): CRITICAL, HIGH, LOW, MEDIUM, UNKNOWN, risk, enum, type

### Community 48 - "properties"
Cohesion: 0.22
Nodes (9): type, type, type, properties, change_class, confidence, direct_eligible, risk_score (+1 more)

### Community 49 - "required"
Cohesion: 0.22
Nodes (9): agent, base_commit, created_at, reviewed_commit, run_id, schema_version, unit_or_task, verdict (+1 more)

### Community 50 - "items"
Cohesion: 0.25
Nodes (9): items, type, items, items, type, additionalProperties, type, acceptance (+1 more)

### Community 51 - "properties"
Cohesion: 0.22
Nodes (9): additionalProperties, properties, type, type, blast, callers_reviewed, pass, risk (+1 more)

### Community 52 - "required"
Cohesion: 0.22
Nodes (9): agent, base_commit, created_at, reviewed_commit, run_id, schema_version, unit_or_task, verdict (+1 more)

### Community 53 - "required"
Cohesion: 0.22
Nodes (9): agent, base_commit, created_at, reviewed_commit, run_id, schema_version, unit_or_task, verdict (+1 more)

### Community 54 - "run_id"
Cohesion: 0.40
Nodes (5): run_id, maxLength, minLength, pattern, type

### Community 55 - "test-adapter-contract.sh"
Cohesion: 0.33
Nodes (7): assert_opencode_clean(), fail(), GRAPHIFY_LOG, HOME, PATH, test-adapter-contract.sh script, snapshot_artifacts()

### Community 56 - "Writing Plans (improve-grade)"
Cohesion: 0.22
Nodes (8): CONTEXT.md creation/refresh, Outcome, PLAN.md template, Planning rules, Step 0 — Recon (always before planning), Step 1 — Create PLAN.md, Step 2 — Generate task files, Writing Plans (improve-grade)

### Community 57 - "items"
Cohesion: 0.25
Nodes (8): from, to, additionalProperties, required, type, transitions, items, type

### Community 58 - "blast-report.schema.json"
Cohesion: 0.25
Nodes (7): additionalProperties, $id, risk, required, $schema, title, type

### Community 59 - "properties"
Cohesion: 0.25
Nodes (8): additionalProperties, properties, type, graph_freshness, status, valid, type, type

### Community 60 - "null"
Cohesion: 0.32
Nodes (8): type, null, string, type, base_commit, plan_commit, reviewed_commit, type

### Community 61 - "items"
Cohesion: 0.25
Nodes (8): items, type, items, type, additionalProperties, type, callers_checked, findings

### Community 62 - "security"
Cohesion: 0.25
Nodes (8): type, type, issues, notes, security, additionalProperties, properties, type

### Community 63 - "drift"
Cohesion: 0.25
Nodes (8): type, additionalProperties, properties, type, detected, drift, reason, type

### Community 64 - "items"
Cohesion: 0.29
Nodes (8): items, type, items, type, additionalProperties, type, acceptance, findings

### Community 65 - "type"
Cohesion: 0.29
Nodes (8): type, boolean, null, string, type, base_commit, reviewed_commit, type

### Community 66 - "cli-flow.test.js"
Cohesion: 0.22
Nodes (3): repoRoot, runCli, temporaryRoots

### Community 67 - "enum"
Cohesion: 0.29
Nodes (7): DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED, status, enum, type

### Community 68 - "reasons"
Cohesion: 0.29
Nodes (7): type, reasons, uncertainties, items, type, items, type

### Community 69 - "type"
Cohesion: 0.32
Nodes (8): type, type, null, string, base_commit, head_commit, worktree_head, type

### Community 70 - "enum"
Cohesion: 0.29
Nodes (7): APPROVED, BLOCKED, ISOLATION_VIOLATION, REQUEST_CHANGES, verdict, enum, type

### Community 71 - "handoff-code-reviewer.schema.json"
Cohesion: 0.29
Nodes (6): additionalProperties, allOf, $id, $schema, title, type

### Community 72 - "enum"
Cohesion: 0.29
Nodes (7): APPROVED, BLOCKED, ISOLATION_VIOLATION, REQUEST_CHANGES, verdict, enum, type

### Community 73 - "handoff-unified-reviewer.schema.json"
Cohesion: 0.29
Nodes (6): additionalProperties, allOf, $id, $schema, title, type

### Community 74 - "blast"
Cohesion: 0.29
Nodes (7): additionalProperties, properties, type, blast, pass, risk, type

### Community 75 - "enum"
Cohesion: 0.29
Nodes (7): APPROVED, BLOCKED, ISOLATION_VIOLATION, REQUEST_CHANGES, verdict, enum, type

### Community 76 - "properties"
Cohesion: 0.25
Nodes (8): type, type, properties, at, evidence, from, to, type

### Community 77 - "test-install-only.sh"
Cohesion: 0.33
Nodes (5): GRAPHIFY_LOG, HOME, PATH, run_install(), test-install-only.sh script

### Community 79 - "enum"
Cohesion: 0.33
Nodes (6): CONSERVATIVE, PRECISE, UNSUPPORTED, enum, type, analysis_quality

### Community 80 - "enum"
Cohesion: 0.33
Nodes (6): partial, trusted, enum, type, unknown, evidence_quality

### Community 81 - "enum"
Cohesion: 0.33
Nodes (6): balanced, fast, strict, enum, type, profile

### Community 82 - "enum"
Cohesion: 0.33
Nodes (6): dual, none, unified, review_level, enum, type

### Community 83 - "enum"
Cohesion: 0.33
Nodes (6): balanced, fast, strict, enum, type, profile

### Community 84 - "enum"
Cohesion: 0.33
Nodes (6): dual, none, unified, review_level, enum, type

### Community 85 - "test-optional-agents.sh"
Cohesion: 0.33
Nodes (4): GRAPHIFY_LOG, HOME, PATH, test-optional-agents.sh script

### Community 86 - "install.sh"
Cohesion: 0.53
Nodes (4): bak(), manifest_record_original(), prune_optional_from_dir(), install.sh script

### Community 87 - "policy.js"
Cohesion: 0.17
Nodes (20): applyBlastEscalation(), applyImpactEscalation(), blastRisk(), effectivePolicy(), EXEC_RANK, isMultiTaskRun(), isTrustedLowRiskBlast(), isTrustedLowRiskImpact() (+12 more)

### Community 88 - "drift_check"
Cohesion: 0.40
Nodes (5): pass, additionalProperties, required, type, drift_check

### Community 89 - "stage"
Cohesion: 0.40
Nodes (5): post-blast, pre-implementation, stage, enum, type

### Community 90 - "enum"
Cohesion: 0.40
Nodes (5): enum, type, delegated, direct, execution_mode

### Community 91 - "enum"
Cohesion: 0.40
Nodes (5): enum, type, delegated, direct, execution_mode

### Community 92 - "handoff-spec-reviewer.schema.json"
Cohesion: 0.29
Nodes (6): additionalProperties, allOf, $id, $schema, title, type

### Community 93 - "nexus-branch-cleanup.sh"
Cohesion: 0.60
Nodes (3): is_protected(), nexus-branch-cleanup.sh script, usage()

### Community 94 - "Integration Reviewer"
Cohesion: 0.33
Nodes (5): Checks, Handoff, Integration Reviewer, Role, Rules

### Community 95 - "enum"
Cohesion: 0.33
Nodes (6): targeted, wider, strict, verification_mode, enum, type

### Community 96 - "unsupported_fields"
Cohesion: 0.50
Nodes (4): type, unsupported_fields, additionalProperties, type

### Community 97 - "schema_version"
Cohesion: 0.50
Nodes (4): 1.0, schema_version, enum, type

### Community 98 - "schema_version"
Cohesion: 0.50
Nodes (4): 1.1, schema_version, enum, type

### Community 99 - "schema_version"
Cohesion: 0.50
Nodes (4): 1.1, schema_version, enum, type

### Community 100 - "schema_version"
Cohesion: 0.50
Nodes (4): 1.1, schema_version, enum, type

### Community 101 - "schema_version"
Cohesion: 0.50
Nodes (4): 1.1, schema_version, enum, type

### Community 103 - "worktree.js"
Cohesion: 0.67
Nodes (5): createTaskWorktree(), listTaskWorktrees(), removeTaskWorktree(), run(), worktreeRoot()

### Community 104 - "dimensions"
Cohesion: 0.67
Nodes (3): additionalProperties, type, dimensions

### Community 105 - "nexus-blast.js"
Cohesion: 0.40
Nodes (4): args, __dirname, impact, r

### Community 107 - "Diagnostician"
Cohesion: 0.50
Nodes (3): Diagnostician, Output, Role

### Community 108 - "gate-hardening.test.js"
Cohesion: 0.24
Nodes (15): CLASSIFY_APPLY_SOURCE, sealBlastArtifact(), sealGraphArtifact(), sealImpactArtifact(), goodImplementerHandoff(), goodIntegrationHandoff(), goodUnifiedHandoff(), handoffEnvelope() (+7 more)

### Community 109 - "agent"
Cohesion: 0.67
Nodes (3): minLength, type, agent

### Community 110 - "created_at"
Cohesion: 0.67
Nodes (3): minLength, type, created_at

### Community 111 - "run_id"
Cohesion: 0.67
Nodes (3): run_id, minLength, type

### Community 112 - "confidence"
Cohesion: 0.50
Nodes (4): maximum, minimum, type, confidence

### Community 120 - "Implementer Dispatch Template (V4 — TDD + scope lock + impact)"
Cohesion: 0.50
Nodes (3): Handoff fields (schema_version 1.1 — required envelope), Implementer Dispatch Template (V4 — TDD + scope lock + impact), Report

### Community 125 - "orchestrator.md"
Cohesion: 0.50
Nodes (3): Dispatch rules, Lifecycle, Portable CLI

### Community 129 - "test-uninstall-lifecycle.sh"
Cohesion: 0.83
Nodes (3): fail(), pass(), test-uninstall-lifecycle.sh script

### Community 130 - "reasons"
Cohesion: 0.67
Nodes (3): reasons, items, type

### Community 131 - "agent"
Cohesion: 0.67
Nodes (3): minLength, type, agent

### Community 132 - "unit_or_task"
Cohesion: 0.67
Nodes (3): unit_or_task, minLength, type

### Community 147 - "schema-validate.js"
Cohesion: 0.27
Nodes (16): normalizeAndValidateHandoff(), cache, __dirname, HANDOFF_SCHEMA, isObject(), loadAllSchemas(), loadSchema(), matchesType() (+8 more)

### Community 148 - "verifySealedArtifact"
Cohesion: 0.30
Nodes (7): nowIso(), sealProviderArtifact(), sha256Digest(), stableStringify(), verifySealedArtifact(), createNexusImpactProvider(), validateCachedReport()

### Community 149 - "createMetricsTelemetry"
Cohesion: 0.24
Nodes (11): addMetricTotals(), createMetricsTelemetry(), finiteNonNegative(), getAgentCallBudget(), metricsPathFor(), normalizeTokens(), numericMetric(), safeMetricLabel() (+3 more)

### Community 150 - "boolean"
Cohesion: 0.29
Nodes (7): type, type, boolean, blast_verified, impact_verified, verified, type

### Community 151 - "drift.js"
Cohesion: 0.60
Nodes (4): assessDrift(), fileHash(), isPlanCommitAcceptable(), validateDriftReport()

### Community 152 - "template-gate-contract.test.js"
Cohesion: 0.60
Nodes (4): handoffFromImplementerTemplate(), handoffFromUnifiedTemplate(), read(), root

### Community 153 - "created_at"
Cohesion: 0.67
Nodes (3): minLength, type, created_at

## Knowledge Gaps
- **715 isolated node(s):** `__dirname`, `skillsDir`, `TERMINAL_RUN_STATES`, `KNOWLEDGE_RELEVANT_STATES`, `pkgRoot` (+710 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **21 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `collectFlags()` connect `classify.js` to `nexus-estimate-calls.js`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Why does `flag()` connect `nexus-estimate-calls.js` to `classify.js`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **Why does `classify()` connect `classify.js` to `nexus-run.js`, `gate-hardening.test.js`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **What connects `__dirname`, `skillsDir`, `TERMINAL_RUN_STATES` to the rest of the system?**
  _715 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `providers.js` be split into smaller, more focused modules?**
  _Cohesion score 0.09113300492610837 - nodes in this community are weakly interconnected._
- **Should `classify.js` be split into smaller, more focused modules?**
  _Cohesion score 0.05393000573723465 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.043478260869565216 - nodes in this community are weakly interconnected._