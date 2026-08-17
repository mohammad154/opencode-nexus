# Graph Report - opencode-nexus  (2026-08-18)

## Corpus Check
- 85 files · ~55,348 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1348 nodes · 1897 edges · 129 communities (119 shown, 10 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 6 edges (avg confidence: 0.55)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `af9155fe`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- nexus-blast.js
- providers.js
- classify.js
- package.json
- properties
- properties
- Orchestrating (V3 — profiles)
- diff-evidence.js
- state-machine.js
- ensure-cli-on-path.js
- nexus-run.js
- properties
- migrate-artifacts.js
- null
- properties
- properties
- gate-hardening.test.js
- required
- schema-validate.js
- plugins/nexus.js
- OpenCode Nexus
- enum
- properties
- Blast Radius (CodeLookup-inspired pre-implementation safety check)
- properties
- type
- null
- nexus-estimate-calls.js
- Procedure
- type
- policy.js
- classification-evidence.schema.json
- run-state.schema.json
- trajectory-replay.test.js
- Using Nexus (V3 — executable workflow engine)
- properties
- properties
- properties
- Finishing a Development Branch (V3 – profiles + script cleanup)
- Outcome Memory — LESSONS.md (V3)
- Using Feature Branches (V3)
- bin/nexus.js
- properties
- enum
- null
- object
- Nexus V3 workflow
- Installing OpenCode Nexus V3
- properties
- required
- items
- properties
- required
- required
- properties
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
- handoff-code-reviewer.schema.json
- enum
- handoff-spec-reviewer.schema.json
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
- Install
- drift_check
- stage
- enum
- enum
- run_id
- nexus-branch-cleanup.sh
- nexus-bin.test.js
- unsupported_fields
- schema_version
- schema_version
- schema_version
- schema_version
- schema_version
- calls.test.js
- Prerequisites
- dimensions
- semantic_signals
- agent
- created_at
- run_id
- agent
- created_at
- run_id
- unit_or_task
- Branch Cleanup (V3 — script-first)
- Unified Reviewer Dispatch Template (V3 — combined spec + quality)
- uninstall.sh
- install-git-hook.sh
- nexus-blast.sh script
- brainstorming/SKILL.md
- code-reviewer-prompt.md
- implementer-prompt.md
- spec-reviewer-prompt.md

## God Nodes (most connected - your core abstractions)
1. `classify()` - 26 edges
2. `canTransition()` - 22 edges
3. `reclassifyAfterBlast()` - 17 edges
4. `collectGitDiffEvidence()` - 17 edges
5. `transition()` - 14 edges
6. `OpenCode Nexus` - 14 edges
7. `enum` - 13 edges
8. `cmdClassify()` - 13 edges
9. `files` - 12 edges
10. `writeRunState()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `sealedPreciseGraph()` --calls--> `sealGraphArtifact()`  [EXTRACTED]
  tests/helpers/gate-fixtures.js → scripts/lib/state-machine.js
- `sealedLowBlast()` --calls--> `sealBlastArtifact()`  [EXTRACTED]
  tests/helpers/gate-fixtures.js → scripts/lib/state-machine.js
- `collectFlags()` --indirect_call--> `flag()`  [INFERRED]
  scripts/lib/classify.js → scripts/nexus-estimate-calls.js
- `classifyFromArgs()` --calls--> `loadWorkflowConfig()`  [EXTRACTED]
  scripts/nexus-classify.js → scripts/lib/classify.js
- `cmdClassify()` --calls--> `loadWorkflowConfig()`  [EXTRACTED]
  scripts/nexus-run.js → scripts/lib/classify.js

## Import Cycles
- None detected.

## Communities (129 total, 10 thin omitted)

### Community 0 - "nexus-blast.js"
Cohesion: 0.07
Nodes (43): asObject(), currentHead(), edgeEndpoint(), GRAPHIFY_RELATION_SET, GRAPHIFY_RELATIONS, graphRootFromOutput(), manifestSourcePath(), mapFilesToGraphifyNodes() (+35 more)

### Community 1 - "providers.js"
Cohesion: 0.07
Nodes (42): addMetricTotals(), annotateGraphifyBlastReport(), BLAST_PROVIDER_METADATA, collectFileValues(), collectRawFileValues(), createEditValidator(), createGraphifyBlastProvider(), createGraphifyGraphProvider() (+34 more)

### Community 2 - "classify.js"
Cohesion: 0.09
Nodes (45): addWeighted(), allFilesAreTestsOrDocs(), applyConfidenceGates(), asObject(), assessEvidenceQuality(), blastRiskOf(), CLASS_FLAGS, classify() (+37 more)

### Community 3 - "package.json"
Cohesion: 0.04
Nodes (45): bin, nexus, opencode-nexus, bugs, url, description, engines, node (+37 more)

### Community 4 - "properties"
Cohesion: 0.06
Nodes (38): drift, additionalProperties, items, type, type, type, enum, type (+30 more)

### Community 5 - "properties"
Cohesion: 0.05
Nodes (38): additionalProperties, minLength, type, type, minLength, type, description, $id (+30 more)

### Community 6 - "Orchestrating (V3 — profiles)"
Cohesion: 0.06
Nodes (30): Anti-patterns, Dual review (strict, or high-risk under any profile), Fix loops, Resolve the local agent name, Review gates by profile, Skip review (documentation-only under fast), Subagent Dispatch (OpenCode) — V3 profiles, Unified review (fast/balanced, low–medium risk) (+22 more)

### Community 7 - "diff-evidence.js"
Cohesion: 0.15
Nodes (28): boundaryForFile(), collectGitDiffEvidence(), diffCommandSets(), ensurePatchFile(), exportedSymbolsFromText(), extractExportedSymbols(), lineCount(), mergeGitDiffEvidence() (+20 more)

### Community 8 - "state-machine.js"
Cohesion: 0.18
Nodes (24): hasExplicitBlastVerification(), isUnknownGraph(), assertVerificationGates(), bindImplementerHandoffErrors(), bindReviewerHandoffErrors(), canTransition(), exists(), gitIsAncestor() (+16 more)

### Community 9 - "ensure-cli-on-path.js"
Cohesion: 0.17
Nodes (19): BIN_NAMES, ensureUserBinOnPath(), isGlobalInstall(), isOurShim(), isTruthy(), pathHasDir(), pkg, pkgRoot (+11 more)

### Community 10 - "nexus-run.js"
Cohesion: 0.26
Nodes (23): latestRunState(), readRunState(), writeRunState(), createDefaultProviders(), cmdCan(), cmdClassify(), cmdDrift(), cmdInit() (+15 more)

### Community 11 - "properties"
Cohesion: 0.09
Nodes (23): type, type, type, type, type, type, type, properties (+15 more)

### Community 12 - "migrate-artifacts.js"
Cohesion: 0.19
Nodes (17): createEmptyRunState(), deepClone(), inferRunFromContext(), isLegacyHandoffVersion(), LEGACY_HANDOFF_VERSIONS, listRunIds(), normalizeAndValidateHandoff(), normalizeHandoff() (+9 more)

### Community 13 - "null"
Cohesion: 0.14
Nodes (20): type, type, type, type, properties, boolean, null, string (+12 more)

### Community 14 - "properties"
Cohesion: 0.11
Nodes (19): minLength, type, minLength, type, type, type, properties, agent (+11 more)

### Community 15 - "properties"
Cohesion: 0.11
Nodes (19): minLength, type, minLength, type, type, properties, agent, created_at (+11 more)

### Community 16 - "gate-hardening.test.js"
Cohesion: 0.24
Nodes (11): assessDrift(), fileHash(), isPlanCommitAcceptable(), CLASSIFY_APPLY_SOURCE, goodImplementerHandoff(), goodUnifiedHandoff(), handoffEnvelope(), mockTrustProviders() (+3 more)

### Community 17 - "required"
Cohesion: 0.11
Nodes (17): commit, drift_check, status, verification_gates, additionalProperties, allOf, $id, agent (+9 more)

### Community 18 - "schema-validate.js"
Cohesion: 0.28
Nodes (15): cache, __dirname, HANDOFF_SCHEMA, isObject(), loadAllSchemas(), loadSchema(), matchesType(), SCHEMAS_DIR (+7 more)

### Community 19 - "plugins/nexus.js"
Cohesion: 0.18
Nodes (12): COMPACT_ROUTER, __dirname, getBootstrapText(), KNOWLEDGE_RELEVANT_STATES, NexusPlugin(), readContextFile(), readGraphifySummary(), readPlanFile() (+4 more)

### Community 20 - "OpenCode Nexus"
Cohesion: 0.12
Nodes (16): At a glance, Contents, Customize models, First graph in a repo, Further reading, How the workflow works, Installed agents, License (+8 more)

### Community 21 - "enum"
Cohesion: 0.13
Nodes (15): BLAST_READY, CLASSIFIED, COMPLETED, CREATED, DIRECT_IMPLEMENTING, FAILED, GRAPH_READY, IMPLEMENTING (+7 more)

### Community 22 - "properties"
Cohesion: 0.13
Nodes (15): type, type, type, type, type, properties, blast_risk, change_class (+7 more)

### Community 23 - "Blast Radius (CodeLookup-inspired pre-implementation safety check)"
Cohesion: 0.13
Nodes (14): Artifacts (when --task N), Blast Radius (CodeLookup-inspired pre-implementation safety check), Commands, Hard rules, How Graphify improves blast, Human markdown (default), Integration points, JSON (via --json or after markdown separated by ---JSON--- marker) (+6 more)

### Community 24 - "properties"
Cohesion: 0.14
Nodes (14): type, type, properties, legacy_unverified, lessons_checked, role, task_id, unit_or_task (+6 more)

### Community 25 - "type"
Cohesion: 0.14
Nodes (14): items, type, type, object, files_changed, scope_extras, tasks_completed, tests (+6 more)

### Community 26 - "null"
Cohesion: 0.20
Nodes (14): type, type, type, type, type, null, string, type (+6 more)

### Community 27 - "nexus-estimate-calls.js"
Cohesion: 0.16
Nodes (13): args, breakdownFor(), callsForUnit(), changeClass, chosen, DUAL_REVIEW_CLASSES, estimate(), executionMode (+5 more)

### Community 28 - "Procedure"
Cohesion: 0.14
Nodes (13): Pre-requisites, Procedure, Reconcile, Reference: shadcn/improve reconcile contract borrowed, Step 0 — Read state, Step 1 — Drift check (semantic primary, commit distance secondary), Step 2 — Verify DONE tasks still hold, Step 3 — Investigate BLOCKED / NEEDS_CONTEXT tasks (+5 more)

### Community 29 - "type"
Cohesion: 0.15
Nodes (13): items, type, items, type, type, affected_packages, hard_triggers, reasons (+5 more)

### Community 30 - "policy.js"
Cohesion: 0.28
Nodes (12): applyBlastEscalation(), blastRisk(), effectivePolicy(), EXEC_RANK, isTrustedLowRiskBlast(), isUnknownBlast(), maxExecution(), maxProfile() (+4 more)

### Community 31 - "classification-evidence.schema.json"
Cohesion: 0.17
Nodes (11): confidence, risk_score, additionalProperties, $id, profile, reasons, schema_version, required (+3 more)

### Community 32 - "run-state.schema.json"
Cohesion: 0.17
Nodes (11): state, transitions, additionalProperties, $id, profile, run_id, schema_version, required (+3 more)

### Community 33 - "trajectory-replay.test.js"
Cohesion: 0.24
Nodes (7): appendTrajectoryStep(), assertStep(), readTrajectory(), replayTrajectory(), repoRoot, runCli, temporaryRoots

### Community 34 - "Using Nexus (V3 — executable workflow engine)"
Cohesion: 0.17
Nodes (12): Adaptive direct path (narrow), Agent Selection, Branch cleanup, Context Preservation, Red Flags, Skill order for new work, Skill Router, Subagent dispatch (+4 more)

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

### Community 41 - "bin/nexus.js"
Cohesion: 0.29
Nodes (9): [command, ...args], doctor(), fail(), hasCommand(), isNexusPluginSpec(), pkg, pkgRoot, pluginEntries() (+1 more)

### Community 42 - "properties"
Cohesion: 0.24
Nodes (10): number, type, additionalProperties, properties, type, null, direct_callers, graphify (+2 more)

### Community 43 - "enum"
Cohesion: 0.27
Nodes (10): enum, type, HIGH, LOW, MEDIUM, UNKNOWN, computed_risk, risk (+2 more)

### Community 44 - "null"
Cohesion: 0.24
Nodes (10): type, boolean, null, string, type, type, base_commit, plan_commit (+2 more)

### Community 45 - "object"
Cohesion: 0.20
Nodes (10): additionalProperties, type, additionalProperties, type, additionalProperties, type, object, blast (+2 more)

### Community 46 - "Nexus V3 workflow"
Cohesion: 0.22
Nodes (9): Agent roster and dispatch names, Artifacts, Deterministic gates, Execution units and review, Graph and blast, Lifecycle, Nexus V3 workflow, Profiles (+1 more)

### Community 47 - "Installing OpenCode Nexus V3"
Cohesion: 0.22
Nodes (9): Customize models, Install, Installing OpenCode Nexus V3, OpenCode outputs, Prerequisites, Uninstall, V3 workflow and profiles, Verify graph and blast evidence (+1 more)

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

### Community 54 - "properties"
Cohesion: 0.22
Nodes (9): type, 1.0, properties, created_at, schema_version, updated_at, enum, type (+1 more)

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
Nodes (7): risk, additionalProperties, $id, required, $schema, title, type

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
Cohesion: 0.25
Nodes (3): repoRoot, runCli, temporaryRoots

### Community 67 - "enum"
Cohesion: 0.29
Nodes (7): DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED, status, enum, type

### Community 68 - "reasons"
Cohesion: 0.29
Nodes (7): type, reasons, uncertainties, items, type, items, type

### Community 69 - "handoff-code-reviewer.schema.json"
Cohesion: 0.29
Nodes (6): additionalProperties, allOf, $id, $schema, title, type

### Community 70 - "enum"
Cohesion: 0.29
Nodes (7): APPROVED, BLOCKED, ISOLATION_VIOLATION, REQUEST_CHANGES, verdict, enum, type

### Community 71 - "handoff-spec-reviewer.schema.json"
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
Cohesion: 0.29
Nodes (7): type, type, properties, at, from, to, type

### Community 77 - "test-install-only.sh"
Cohesion: 0.33
Nodes (5): GRAPHIFY_LOG, HOME, PATH, run_install(), test-install-only.sh script

### Community 78 - "blast-output.test.js"
Cohesion: 0.29
Nodes (3): blast, __dirname, root

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
Cohesion: 0.60
Nodes (3): bak(), prune_optional_from_dir(), install.sh script

### Community 87 - "Install"
Cohesion: 0.40
Nodes (5): From a local clone, Global CLI (recommended), Install, Optional compatibility agent, What gets written

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

### Community 92 - "run_id"
Cohesion: 0.40
Nodes (5): run_id, maxLength, minLength, pattern, type

### Community 93 - "nexus-branch-cleanup.sh"
Cohesion: 0.60
Nodes (3): is_protected(), nexus-branch-cleanup.sh script, usage()

### Community 94 - "nexus-bin.test.js"
Cohesion: 0.40
Nodes (3): bin, pkg, repoRoot

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

### Community 103 - "Prerequisites"
Cohesion: 0.67
Nodes (3): Optional (recommended), Prerequisites, Required

### Community 104 - "dimensions"
Cohesion: 0.67
Nodes (3): additionalProperties, type, dimensions

### Community 105 - "semantic_signals"
Cohesion: 0.67
Nodes (3): semantic_signals, items, type

### Community 106 - "agent"
Cohesion: 0.67
Nodes (3): minLength, type, agent

### Community 107 - "created_at"
Cohesion: 0.67
Nodes (3): minLength, type, created_at

### Community 108 - "run_id"
Cohesion: 0.67
Nodes (3): run_id, minLength, type

### Community 109 - "agent"
Cohesion: 0.67
Nodes (3): minLength, type, agent

### Community 110 - "created_at"
Cohesion: 0.67
Nodes (3): minLength, type, created_at

### Community 111 - "run_id"
Cohesion: 0.67
Nodes (3): run_id, minLength, type

### Community 112 - "unit_or_task"
Cohesion: 0.67
Nodes (3): unit_or_task, minLength, type

## Knowledge Gaps
- **610 isolated node(s):** `__dirname`, `skillsDir`, `TERMINAL_RUN_STATES`, `KNOWLEDGE_RELEVANT_STATES`, `COMPACT_ROUTER` (+605 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `properties` connect `properties` to `schema_version`, `properties`, `enum`, `properties`, `null`, `required`, `drift_check`, `type`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **Why does `properties` connect `properties` to `run-state.schema.json`, `object`, `enum`, `enum`, `enum`, `items`, `null`, `enum`, `run_id`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **Why does `classify()` connect `classify.js` to `gate-hardening.test.js`, `nexus-run.js`, `diff-evidence.js`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **What connects `__dirname`, `skillsDir`, `TERMINAL_RUN_STATES` to the rest of the system?**
  _610 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `nexus-blast.js` be split into smaller, more focused modules?**
  _Cohesion score 0.07390648567119155 - nodes in this community are weakly interconnected._
- **Should `providers.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06823529411764706 - nodes in this community are weakly interconnected._
- **Should `classify.js` be split into smaller, more focused modules?**
  _Cohesion score 0.08843537414965986 - nodes in this community are weakly interconnected._