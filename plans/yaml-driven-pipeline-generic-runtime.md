# YAML-Driven Pipeline Generic Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make full and delta scans run exclusively from versioned YAML pipeline snapshots through one generic runtime, with schema annotations handling generated and normalized fields.

**Architecture:** TypeScript owns the fixed execution lifecycle, schema processing, queue dispatch, persistence effects, and convergence. YAML owns pipeline topology, stage runtime settings, prompts, schemas, reports, artifact mappings, routes, and fan-out. Candidate IDs are regenerated in place through a schema annotation; artifact paths are never derived from candidate IDs.

**Tech Stack:** TypeScript, YAML, Zod, JSON Schema, BullMQ, Drizzle ORM, PostgreSQL, Vitest, Docker.

## Global Constraints

- Work and E2E validation run only in dev; do not modify or restart release.
- Preserve unrelated dirty-worktree changes.
- Do not retain the concrete full/delta runtime after the cutover.
- YAML may use only registered generators, normalizers, and persistence effects; it cannot execute arbitrary TypeScript.
- All agent stages use YAML `runtimeConfig.prompt` or `promptFile`; no source-code prompt fallback.
- `output.json` remains the structured result file and `/task/stdout` remains the runtime event stream.
- Candidate files keep the path produced by the agent. Regenerating `Candidate.id` updates the JSON file in place and does not rewrite `ScanTargetManifest.candidates`.

---

### Task 1: Replace YAML Operations With Schema Annotations

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/scan-pipeline-schema-contracts.ts`
- Create: `packages/server/src/services/scan/pipeline/scan-pipeline-schema-transforms.ts`
- Create: `packages/server/src/services/scan/pipeline/scan-pipeline-schema-transforms.test.ts`
- Modify: `packages/server/src/services/scan/pipeline/definitions/schemas/shared.yaml`
- Delete after replacement: `packages/server/src/services/scan/pipeline/yaml-pipeline-operations.ts`
- Delete after replacement: `packages/server/src/services/scan/pipeline/yaml-pipeline-operations.test.ts`

**Interfaces:**

```ts
type JsonSchemaValueAnnotation =
	| {
		path: string;
		kind: "generate";
		generator: "uuid";
		length: number;
		prefix: string;
	}
	| {
		path: string;
		kind: "normalize";
		steps: Array<"trim" | "remove-empty" | "unique">;
	};

type JsonSchemaContract = {
	kind: "json-schema";
	schema: JsonSchemaObject;
	artifactAnnotations: JsonSchemaArtifactAnnotation[];
	valueAnnotations: JsonSchemaValueAnnotation[];
	validate: (value: unknown) => void;
};

declare function applySchemaTransforms(input: {
	contract: JsonSchemaContract;
	taskDir: string;
	value: unknown;
}): Promise<unknown>;
```

- [ ] Add failing tests for `$generate`, `$normalize`, nested object paths, `$pathOf` artifacts, malformed annotations, and path traversal.
- [ ] Extend JSON Schema normalization to collect `$generate` and `$normalize` while removing these custom keys from the validator-facing schema.
- [ ] Implement the `uuid` generator with `randomUUID().replace(/-/g, "").slice(0, length)`, enforce `1 <= length <= 32`, prepend `prefix`, and retry duplicates within one transform call.
- [ ] Apply generated fields before final validation. Generated values always replace existing values.
- [ ] Implement `trim`, `remove-empty`, and stable `unique` normalization in declared order.
- [ ] For `$pathOf`, load the referenced artifact under `taskDir`, apply its value annotations, atomically replace the same file, and preserve the original manifest path.
- [ ] Annotate `Candidate.id` with UUID length `6` and prefix `candidate-`.
- [ ] Annotate `likelyVulnerabilityClasses` with `trim`, `remove-empty`, and `unique`.
- [ ] Run:

```bash
pnpm --filter=@vulseek/server exec tsx --test \
  src/services/scan/pipeline/scan-pipeline-schema-contracts.test.ts \
  src/services/scan/pipeline/scan-pipeline-schema-transforms.test.ts
```

Expected: all schema contract and transform tests pass.

---

### Task 2: Define The Generic Stage Lifecycle

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/yaml-pipeline-runtime.ts`
- Modify: `packages/server/src/services/scan/pipeline/yaml-pipeline-runtime.test.ts`
- Modify: `packages/server/src/services/scan/stages/generic-agent.stage.ts`
- Modify: `packages/server/src/services/scan/stages/full-scan-stage.runtime.ts`

**Interfaces:**

```ts
type YamlStageEffect =
	| { type: "sync-candidates" }
	| { type: "project-candidate-result"; resultStage: "analyze" | "critique" | "verify" | "triage" };

type YamlStageReport = {
	path: string;
	required: boolean;
};
```

- [ ] Replace the stage `operations` contract with `effects` and optional `report` declarations.
- [ ] Make the runtime lifecycle fixed: prepare input, resolve prompt, run agent, parse `output.json`, apply schema transforms, validate output and referenced artifacts, verify report, execute effects, dispatch edges, and finalize the task.
- [ ] Keep repository preparation and target-context update in the pipeline-entry lifecycle rather than exposing them as YAML effects.
- [ ] Reject unknown effects, unresolved prompt variables, missing required reports, output paths outside task root, and invalid `output.json`.
- [ ] Ensure effect execution and task result persistence use the existing transaction boundaries; a persistence failure must fail the task and prevent downstream dispatch.
- [ ] Remove all calls to `executeYamlOperations()` and the heuristic that writes fields ending in `Path`.
- [ ] Run the generic runtime and stage tests and confirm no operation-based behavior remains.

---

### Task 3: Describe Full And Delta Entirely In YAML

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/definitions/pipelines/full.yaml`
- Modify: `packages/server/src/services/scan/pipeline/definitions/pipelines/delta.yaml`
- Modify: `packages/server/src/services/scan/pipeline/definitions/stages/*.yaml`
- Modify: `packages/server/src/services/scan/pipeline/scan-pipeline-definitions.ts`
- Modify: `packages/server/src/services/scan/pipeline/scan-pipeline-definitions.test.ts`

- [ ] Add complete stage runtime settings, prompt values, reports, effects, routes, fan-out rules, and explicit edge artifact mappings.
- [ ] Keep agent-produced structured artifacts represented by `$pathOf`:
  - `repository-profile`: repository and modules.
  - `delta-scope`: repository and functions.
  - `attack-surface-model`: threat model.
  - `identify-target`: targets.
  - `scan-target`: candidates.
- [ ] Declare required reports only for `analyze-finding` (`01_report.md`), `verify-finding` (`01_verify_report.md`), and `triage-finding` (`01_triage_report.md`). `critique-finding` has no report.
- [ ] Encode downstream materialization explicitly: repository/module/threat-model/target/candidate copies plus draft-analysis, final-analysis, verify-result, critic-feedback, and optional analysis-report-template serialization.
- [ ] Preserve the current analyze/critique loop and the verify/triage route predicates exactly.
- [ ] Validate pipeline definitions at startup and reject missing stages, invalid edges, invalid selectors, unsupported effects, and incomplete prompt values.
- [ ] Add a test-only YAML pipeline proving a new pipeline and a new generic stage require no new TypeScript stage builder.

---

### Task 4: Cut Full And Delta Over To The Generic Builder

**Files:**
- Modify: `packages/server/src/services/scan.ts`
- Modify: `packages/server/src/services/scan/pipeline/pipeline-runner.ts`
- Modify: `packages/server/src/services/scan/pipeline/stage-definition.ts`

- [ ] Add failing tests proving `runFullScan()`, `runDeltaScan()`, rerun, recovery, and stage graph use the job's normalized YAML snapshot.
- [ ] Route `runFullScan()` to `buildYamlPipeline(context, "full")` and `runDeltaScan()` to `buildYamlPipeline(context, "delta")`.
- [ ] Build the stage graph from the same snapshot used for execution.
- [ ] Change queue binding to accept validated YAML stage IDs without casting to `ScanStageQueueKind`.
- [ ] Move edge copy/serialization and route/fan-out task creation into the generic edge executor.
- [ ] Delete `buildFullScanPipeline()`, the delta wrapper, concrete `createXXXStageDefinition()` registrations, handwritten edge task creators, `rewriteCandidateManifestIds()`, and imports that become unused.
- [ ] Keep prompt Markdown files and domain schemas; delete only stage-specific execution wrappers after reference scans prove they are unused.
- [ ] Run `rg` for every deleted builder and confirm there are no runtime references.

---

### Task 5: Make V2 Snapshots Complete And Fail Fast

**Files:**
- Modify: `apps/vulseek/drizzle/0215_scan_pipeline_definition_v2.sql`
- Modify: `apps/vulseek/drizzle/meta/_journal.json` only if the registered entry is currently incorrect
- Modify: `apps/vulseek/__test__/server/migration-journal.test.ts`
- Modify: `packages/server/src/services/scan/api/scan-jobs.ts`
- Modify: `packages/server/src/services/scan/persistence/scan-job.repo.ts`

- [ ] Add migration tests with representative full and delta v1 snapshots, malformed snapshots, and an empty database.
- [ ] Convert legacy snapshots into complete normalized v2 definitions, preserving task stage IDs, parent relationships, routes, artifact relationships, runtime overrides, and disabled settings.
- [ ] Make snapshot parsing fail at startup when conversion cannot produce a valid v2 definition.
- [ ] Ensure new jobs persist the full v2 snapshot once and always execute from it; later YAML edits must not change an existing job.
- [ ] Verify migration retry is idempotent and does not rewrite already-valid v2 snapshots.

---

### Task 6: Repair The Existing Test Baseline

**Files:**
- Modify: `packages/server/package.json`
- Modify: affected imports under `apps/vulseek/__test__/scan/` and `apps/vulseek/__test__/server/` only when an explicit export is not appropriate
- Modify: `apps/vulseek/__test__/scan/running-task-table-layout.test.ts`

- [ ] Add controlled `@vulseek/server/services/*` exports that resolve in source-mode tests and production builds, or replace test-only deep imports with direct source imports when the module is not intended as package API.
- [ ] Re-run the previously failing candidate projection, candidate state, task update, terminal filter, migration, and server tests.
- [ ] Update the Running Task layout assertion to match the current `overflow-visible` behavior; do not revert the existing UI behavior.
- [ ] Keep unrelated failures separate and document their exact command and error rather than changing unrelated application code.

---

### Task 7: Dev-Only Cat Full Scan E2E

**Environment:**
- Project: `cat-cat-prxroj`
- Environment: dev only
- Checkout image: existing Cat checkout image unless its tools hash is stale

- [ ] Inspect dev BullMQ active jobs, database task status, runtime PID, heartbeat, and scan containers.
- [ ] Clean only confirmed stale active runtimes through the normal task failure/cleanup path; preserve valid pending tasks and do not touch release.
- [ ] Start one full scan for `cat-cat-prxroj` and record the job ID, snapshot version, task IDs, queue jobs, and container IDs.
- [ ] Wait for a terminal job state with a bounded timeout. On timeout, collect queue state, task state, container state, `/task/stdout`, and `output.json` diagnostics.
- [ ] Verify every expected YAML stage and edge, analyze/critique routing, verify/triage routing, candidate projection, reports, token/cost persistence, and final job convergence.
- [ ] Verify candidate IDs are regenerated in place while candidate paths remain unchanged.
- [ ] Verify `/task/stdout` contains the required runtime events and no old runtime files are generated.
- [ ] Leave the Cat project, job, artifacts, and scan data in dev after validation.

---

### Task 8: Full Static And Build Verification

- [ ] Run focused pipeline, schema, migration, queue, rerun, recovery, candidate projection, and UI tests.
- [ ] Run:

```bash
pnpm --filter=@vulseek/server exec tsc --noEmit -p tsconfig.server.json
pnpm --filter=vulseek exec tsc --noEmit
pnpm --filter=vulseek exec vitest run __test__/scan __test__/server
pnpm --filter=@vulseek/server build
pnpm --filter=vulseek build
pnpm check
```

- [ ] If host Biome cannot run because of its glibc requirement, run the same command in the repository's build container and record that result.
- [ ] Build the production Docker image without deploying it.
- [ ] Confirm `rg` finds no concrete full/delta builders, stage-specific task creation branches, YAML operation executor, `rewriteCandidateManifestIds`, or `normalize-array` operation.
- [ ] Review the final diff to ensure release configuration, release containers, release database, and unrelated dirty-worktree files were not changed.

## Acceptance Criteria

- Full and delta scans execute exclusively from each job's v2 YAML snapshot.
- A new pipeline composed from existing generic capabilities requires YAML only.
- Candidate ID generation and vulnerability-class normalization are schema annotations, not stage-specific code.
- Candidate artifact paths never change during ID generation.
- Output, artifact, and report validation are automatic runtime behavior.
- Cat full scan reaches a correct terminal state in dev with valid artifacts, projections, reports, and stdout events.
- Relevant tests, typechecks, builds, and Docker build pass, with any genuinely unrelated baseline failure reported separately.
