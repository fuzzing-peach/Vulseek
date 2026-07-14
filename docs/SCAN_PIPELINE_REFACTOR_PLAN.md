# Scan Pipeline Refactor Plan

## Goal

Refactor the current in-container agent execution and scan orchestration into a clearer pipeline with explicit stage boundaries, reusable execution primitives, and strict artifact contracts.

The target is not to change scan behavior first. The target is to make the system easier to evolve for:

- provider changes
- runtime changes
- skill installation changes
- stop / retry / fail handling
- artifact validation
- queue orchestration
- UI state consistency

## Current Execution Model

The current implementation is centered in [packages/server/src/services/scan.ts](packages/server/src/services/scan.ts).

### Main entrypoints

- `runScanJobInContainer()`
- `runProgrammaticFullScan()`
- `runRepositoryProfileInContainer()`
- `runIdentifyTargetTaskInContainer()`
- `runScanTargetTaskInContainer()`
- `runSingleTurnAgentInContainer()`
- `runSandboxAgentHeadlessTurnInContainer()`

### Queue entry

The queue worker starts the scan from [apps/vulseek/server/queues/scans-queue.ts](apps/vulseek/server/queues/scans-queue.ts).

### Runtime integration

Sandbox-agent runtime startup is partly separated into:

- [packages/server/src/services/sandbox-agent/runtime.ts](packages/server/src/services/sandbox-agent/runtime.ts)
- [packages/server/src/services/sandbox-agent/persistence.ts](packages/server/src/services/sandbox-agent/persistence.ts)
- [packages/server/src/services/sandbox-agent/types.ts](packages/server/src/services/sandbox-agent/types.ts)

## Current Full Scan Flow

The effective flow today is:

1. Queue worker loads a scan job.
2. Worker sets scan job status to `scanning`.
3. Worker calls `runScanJobInContainer()`.
4. Full scan enters `runProgrammaticFullScan()`.
5. If repository scan has not completed, `runRepositoryProfileInContainer()` is called.
6. Repository scan calls `runSingleTurnAgentInContainer()`.
7. `runSingleTurnAgentInContainer()` does all runtime setup:
   - `docker run`
   - runtime file initialization
   - Codex home / runtime metadata initialization
   - asset copy
   - runtime skill installation
   - sandbox-agent runtime startup
   - single-turn prompt execution
   - `docker rm -f` in `finally`
8. Repository scan is expected to write:
   - `repository_scan.json`
   - `module_plan.json`
9. Server reads `module_plan.json` and creates `scan_module_tasks`.
10. Module tasks are queued and processed by `runIdentifyTargetTaskInContainer()`.
11. Module scan is expected to write:
   - `module_scan.json`
   - `function_plan.json`
12. Server reads `function_plan.json` and creates `scan_function_tasks`.
13. Function tasks are queued and processed by `runScanTargetTaskInContainer()`.
14. Function scan is expected to write `function_result.json`.
15. Candidate analysis and verification continue later.

## Current Structural Problems

### 1. One oversized service file

[packages/server/src/services/scan.ts](packages/server/src/services/scan.ts) currently mixes:

- database service logic
- prompt construction
- queue orchestration
- scan phase transitions
- artifact synchronization
- runtime file management
- docker lifecycle
- sandbox-agent integration
- retry and reconciliation behavior

This makes every change cross-cutting.

### 2. Pipeline is implicit

The system behaves like a multi-stage pipeline, but the stages are not first-class objects.

The pipeline only exists as scattered control flow across several functions and queue callbacks.

### 3. Stage logic is duplicated

Repository scan, module scan, and function scan all have the same execution skeleton:

- update state
- prepare container runtime
- run one agent turn
- collect artifacts
- persist results
- handle errors

But each stage is hand-written separately.

### 4. Runtime concerns and business concerns are coupled

`runSingleTurnAgentInContainer()` is already a near-generic executor, but it still mixes infrastructure with scan semantics.

Examples of mixed concerns:

- provider env setup
- Codex home setup
- runtime skill installation
- artifact naming
- prompt injection
- thread ID persistence
- scan-specific setup markdown

### 5. Artifact contracts are not first-class

The required schema for stage outputs is mostly written into prompts.

That means a stage can end with `turn/completed` while still failing to produce:

- required files
- valid JSON
- required top-level structure
- required fields

The recent repository scan failures show exactly this weakness.

### 6. State transitions are fragmented

Scan state is mutated from many places via:

- `updateScanJobStatus()`
- `updateScanJobPhase()`
- `updateScanJobRepositoryTaskStatus()`
- `updateScanModuleTaskStatus()`
- `updateScanFunctionTaskStatus()`
- `recalculateScanTaskCounts()`
- `reconcileScanJobCandidatePipelineStatus()`

This makes stop, retry, and failure handling harder to reason about.

## Refactor Target

The refactor should separate the system into four clear layers:

1. pipeline definition
2. stage executor
3. artifact contracts
4. state transition logic
5. candidate analysis and verification stages

## Proposed Directory Structure

```text
packages/server/src/services/scan/
  index.ts
  types.ts

  state/
    scan-state-machine.ts
    scan-task-counts.ts

  runtime/
    container-runtime.ts
    sandbox-agent-runner.ts
    runtime-files.ts
    runtime-skills.ts

  artifacts/
    paths.ts
    readers.ts
    validators.ts
    contracts/
      repository-profile.contract.ts
      module-plan.contract.ts
      identify-target.contract.ts
      function-plan.contract.ts
      function-result.contract.ts

  prompts/
    repository-profile.prompt.ts
    identify-target.prompt.ts
    scan-target.prompt.ts

  repository/
    prepare-repository.ts
    repository-state.ts

  stages/
    repository-profile.stage.ts
    identify-target.stage.ts
    scan-target.stage.ts

  pipeline/
    pipeline-runner.ts
    stage.ts
    full-scan.pipeline.ts
    delta-scan.pipeline.ts

  persistence/
    scan-job.repo.ts
    identify-target-task.repo.ts
    scan-target-task.repo.ts
    candidate.repo.ts
```

## Layer Responsibilities

### Runtime layer

This layer should only answer one question:

How do we run one agent turn in one container?

It should own:

- container start / stop
- runtime file initialization
- asset copy
- runtime skill installation
- sandbox-agent runtime startup
- headless turn execution
- event stream persistence

It should not know:

- what a repository scan is
- what a module plan is
- what artifact names mean at the business level

Suggested files:

- `runtime/container-runtime.ts`
- `runtime/runtime-files.ts`
- `runtime/runtime-skills.ts`
- `runtime/sandbox-agent-runner.ts`

### Artifact contract layer

This layer should define what each stage must produce.

Each contract should define:

- required file paths
- parser
- validator
- normalizer
- error messages for missing or malformed output

Examples:

- `repository-profile.contract.ts`
- `module-plan.contract.ts`
- `identify-target.contract.ts`
- `function-plan.contract.ts`
- `function-result.contract.ts`
- `analysis-result.contract.ts`
- `verification-result.contract.ts`

This layer should use `zod` for strict validation.

A stage should only be considered successful if:

- the turn completed
- the required files exist
- JSON parsing succeeds
- schema validation succeeds
- downstream persistence succeeds

### Stage layer

Each stage should implement a common interface. Analysis and verification should also be first-class stages in the same model, not a separate informal post-processing flow.

Example:

```ts
export interface ScanStage<I, O> {
  name: string;
  run(input: I, ctx: PipelineContext): Promise<O>;
}
```

Repository stage, module stage, function stage, candidate analysis stage, and candidate verification stage should all share the same execution skeleton while differing only in:

- prompt builder
- artifact contract
- persistence logic
- stage-specific input/output types

### Pipeline layer

This layer should define the explicit scan flow. Analysis and verification should remain in the same pipeline model, even if they are queued separately at runtime. Queue boundaries are execution details, not architectural boundaries.

Pipeline should also own stage-level parallelism semantics. In this design, parallelism does not mean global scheduling complexity. It means that a fanout stage should keep as many agent processes running as the current configured concurrency allows. The concurrency value is stored in the database from frontend configuration, and the running pipeline should continuously adapt to that target value.

The intended behavior is:

- if concurrency increases, the stage should immediately start additional agent processes until it reaches the new target
- if concurrency decreases, the stage does not need to kill already running agents
- reduced concurrency takes effect cooperatively, after currently running agents finish
- queue topology is only an execution transport and must not be the owner of concurrency semantics

For full scan, the flow should be expressed explicitly instead of being buried in service code.

Conceptually:

1. prepare repository
2. repository scan
3. sync module plan
4. fan out module scan tasks
5. sync function plans
6. fan out function scan tasks
7. candidate analysis
8. candidate verification

The pipeline layer should orchestrate order and fanout, but it should not know container details.

### Fanout Stage Concurrency Model

Repository scan is a serial stage. Module scan, function scan, candidate analysis, and candidate verification are fanout stages.

A fanout stage should be modeled as a long-lived controller that maintains a desired concurrency rather than as a one-shot batch enqueue.

Conceptually, each fanout stage should track:

- pending items
- running items
- completed items
- desired concurrency loaded from the database

The controller loop should behave like this:

1. load the latest desired concurrency from the database
2. if running count is below desired concurrency, start more agent tasks
3. when any running task finishes, load the latest desired concurrency again
4. continue filling capacity up to the latest target
5. if the target was reduced, do not launch additional tasks until running count naturally drops below the new target

This means the system adapts quickly to frontend configuration changes without introducing preemption logic.

This concurrency model should be owned by the pipeline or stage runner, not by a static worker-level semaphore. Worker processes may still provide a safety ceiling, but the effective stage concurrency must come from the latest persisted configuration.

Suggested stage definition extensions:

```ts
type FanoutStageDefinition = {
  name: string;
  loadDesiredConcurrency: (scanJobId: string) => Promise<number>;
  listPendingItems: (scanJobId: string) => Promise<string[]>;
  runItem: (itemId: string) => Promise<void>;
};
```

The important design rule is that concurrency should be treated as a runtime-controlled target, not as a fixed value captured once when the worker starts.

### State layer

This layer should own all state transitions.

Instead of calling low-level update functions from many places, the pipeline should call explicit transitions such as:

- `job.startScanning(scanJobId)`
- `job.enterPhase(scanJobId, "repository-profile")`
- `job.fail(scanJobId, error)`
- `analysisTask.start(candidateId)`
- `analysisTask.complete(candidateId, output)`
- `analysisTask.fail(candidateId, error)`
- `verificationTask.start(candidateId)`
- `verificationTask.complete(candidateId, output)`
- `verificationTask.fail(candidateId, error)`
- `repositoryTask.start(scanJobId)`
- `repositoryTask.complete(scanJobId)`
- `moduleTask.start(taskId)`
- `moduleTask.complete(taskId, output)`
- `moduleTask.fail(taskId, error)`
- `functionTask.start(taskId)`
- `functionTask.complete(taskId, output)`
- `functionTask.fail(taskId, error)`

This consolidates retry, stop, and failure semantics.

## Most Important Immediate Fix

The current system needs one behavioral correction before or during refactor:

A stage must not be considered successful just because the model turn completed.

The stage success definition must become:

- agent turn completed
- artifact contract satisfied
- persistence succeeded

This is especially important for repository scan because recent failures ended with `turn/completed` but still did not produce `repository_scan.json` or `module_plan.json`.

## First Reusable Abstraction

The best first abstraction is a generic stage executor for containerized agent stages.

Example shape:

```ts
type AgentStageExecutionInput<TArtifacts> = {
  scanJob: ScanJob;
  agentProfile: AgentProfileLike | null;
  containerName: string;
  runtimeDirHost: string;
  runtimeRootInContainer: string;
  codexHome: string;
  cwd: string;
  prompt: string;
  setupMarkdown?: string;
  setupMarkdownPathInContainer?: string;
  artifactContract: ArtifactContract<TArtifacts>;
  onThreadId?: (threadId: string) => Promise<void>;
};

type AgentStageExecutionResult<TArtifacts> = {
  threadId: string;
  runtimePaths: {
    jsonlPath: string;
    textPath: string;
    stderrPath: string;
  };
  artifacts: TArtifacts;
};
```

Then:

```ts
async function executeAgentStage<TArtifacts>(
  input: AgentStageExecutionInput<TArtifacts>
): Promise<AgentStageExecutionResult<TArtifacts>>
```

This function should own:

1. container startup
2. runtime preparation
3. asset copy
4. runtime skill install
5. sandbox-agent runtime startup
6. prompt execution
7. artifact validation
8. cleanup

Repository scan, module scan, and function scan should all call this instead of re-implementing the skeleton.

## Recommended Migration Order

The refactor should be incremental.

### Phase 1: Extract runtime concerns without changing behavior

Move code out of [scan.ts](packages/server/src/services/scan.ts):

- `runSingleTurnAgentInContainer()` helpers into `runtime/`
- `installRuntimeSkillsInContainer()` into `runtime/runtime-skills.ts`
- sandbox-agent headless turn logic into `runtime/sandbox-agent-runner.ts`

Goal:

- reduce the size of `scan.ts`
- isolate infrastructure concerns first

### Phase 2: Extract prompt builders

Move prompt construction into:

- `prompts/repository-profile.prompt.ts`
- `prompts/identify-target.prompt.ts`
- `prompts/scan-target.prompt.ts`

This is low risk and makes later stage extraction cleaner.

### Phase 3: Introduce artifact contracts

Create and wire strict validators for:

- `repository_scan.json`
- `module_plan.json`
- `module_scan.json`
- `function_plan.json`
- `function_result.json`

Do this first for repository scan because it is the current failure hotspot.

At this stage, repository scan should fail immediately if required artifacts are missing or invalid.

### Phase 4: Introduce stage executor abstraction

Create `executeAgentStage()` and migrate:

1. repository scan
2. module scan
3. function scan

At this point, runtime behavior becomes reusable and uniform.

### Phase 5: Introduce explicit pipeline runner

Move orchestration out of `runProgrammaticFullScan()` into `pipeline/full-scan.pipeline.ts`.

Keep the pipeline simple at first. It does not need a full DAG engine immediately. However, fanout stages should already be modeled with dynamic target concurrency loaded from persisted settings so that running pipelines can react when frontend concurrency values change.

### Phase 6: Introduce centralized state transitions

Add `scan-state-machine.ts` and migrate scattered status updates to explicit transition methods.

This phase will improve:

- stop / fail behavior
- retry correctness
- queue consistency
- UI status reliability

## What Should Be Preserved

The refactor should preserve the following behavior unless intentionally changed later:

- current queue topology
- current Docker-based isolated execution model
- current sandbox-agent provider integration
- current live runtime file streaming model
- current repository preparation behavior
- current skill installation behavior at runtime

The first refactor pass should improve structure and validation, not redesign the scan product itself.

## Key Design Rules

### Rule 1

Do not treat `turn/completed` as stage success.

### Rule 2

Every stage must have an explicit artifact contract.

### Rule 3

Runtime code must not know scan business semantics.

### Rule 4

Pipeline orchestration must not know container implementation details.

### Rule 5

State transitions should go through one boundary, not many ad hoc update calls.

## Suggested First Concrete Change Set

If implementation begins now, the highest-value first patch is:

1. Create `packages/server/src/services/scan/runtime/`
2. Extract runtime helpers out of `scan.ts`
3. Create `artifacts/contracts/repository-profile.contract.ts`
4. Validate `repository_scan.json` and `module_plan.json` immediately after repository stage execution
5. Fail repository stage early when contract validation fails

This is the smallest change set that delivers structural benefit and directly fixes the current class of production failures.

## Expected Benefits After Refactor

- cleaner separation between orchestration and execution
- less duplication across repository/module/function/analysis/verification stages
- stronger artifact correctness guarantees
- easier provider and runtime evolution
- easier implementation of stop, retry, and cancel behavior
- stage parallelism that can react to persisted frontend concurrency updates while the pipeline is running
- smaller and more understandable service modules
- lower risk when changing skill installation or prompt structure

## Summary

The current scan system already behaves like a pipeline, but the pipeline is implicit and tightly coupled to runtime details.

The refactor should make the pipeline explicit and move the system toward:

- reusable stage execution
- validated artifact contracts
- centralized state transitions
- smaller modules with single responsibility

The immediate priority is to extract a reusable stage executor and make artifact validation mandatory at stage boundaries. After repository, module, and function stages are normalized, the same abstraction should absorb candidate analysis and verification instead of leaving them as a separate orchestration style.
