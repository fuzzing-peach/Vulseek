# Scan Unified Object Model

This document proposes a unified object model for scan pipeline data.

Goal:

- unify artifact contracts under `packages/server/src/services/scan/artifacts/contracts`
- unify task-row persistence under `packages/server/src/services/scan/persistence`
- make the following domain objects first-class:
  - `Repository`
  - `Module`
  - `Function`
  - `Candidate`
  - `Analysis`
  - `Verification`
- let these objects serve both as:
  - persisted task results
  - stage input types

Verification is kept in the model, but can remain outside stage-input unification temporarily if needed.

## Core Principle

Each stage should operate on a **real domain object**, not an ad-hoc dependency bag.

That object should:

- have a stable `id`
- contain real business data, not only ids
- be reconstructable from DB rows plus joins
- be serializable to artifact JSON
- be storable as the result payload of its task row
- be usable directly as the next stage's input

In other words:

- task table row = execution envelope
- domain object = business payload

The current code mixes these two concerns. This document separates them.

## Current Situation

Today there are two parallel shapes:

1. artifact contracts
2. task DB rows

Examples:

- `module_plan.json` defines module business fields
- `scan_module_tasks` defines module task execution fields

Likewise:

- `function_plan.json` defines function business fields
- `scan_function_tasks` defines function task execution fields

And:

- `analysis_result.json` defines analysis outcome fields
- `candidate_analysis_tasks` stores execution metadata plus result fields

This is close to workable, but the naming and layering are inconsistent.

## Desired Split

For each object family, split fields into two groups:

1. `payload`
2. `task metadata`

### Payload

Fields that describe the actual business object:

- semantic identity
- summary / classification / priority / score
- paths, names, file locations
- result fields produced by the stage

### Task Metadata

Fields that describe execution state:

- `taskId`
- `status`
- `attempt`
- `containerName`
- `threadId`
- `startedAt`
- `completedAt`
- `errorMessage`
- artifact file paths

The unified stage input should mostly be:

```ts
type StageInput<TPayload> = TPayload & {
  task: TaskMeta;
}
```

where `TPayload` is one of:

- `Repository`
- `Module`
- `Function`
- `Candidate`
- `Analysis`
- `Verification`

## Unified Domain Objects

## 1. Repository

Repository is the result of repository scanning.

It should unify:

- repository scan artifact contract
- repository task record
- scan job target context

### Repository payload

```ts
type Repository = {
  id: string;
  scanJobId: string;
  name: string;
  summary: string;
  languages: string[];
  buildSystems: string[];
  runtimeDirectories: string[];
  downrankedDirectories: string[];
  attackSurfaces: string[];
  publicApis: string[];
  vulnerabilityThemes: string[];
  notes: string[];
  targetRef: string | null;
  targetTag: string | null;
  commitSha: string | null;
  baseSha: string | null;
  commitWindow: number;
}
```

### Repository task metadata

```ts
type RepositoryTaskMeta = {
  taskId: string;
  status: "queued" | "running" | "completed" | "failed";
  attempt: number;
  containerName: string | null;
  threadId: string | null;
  repositoryScanMdPath: string | null;
  repositoryScanJsonPath: string | null;
  modulePlanJsonPath: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}
```

### Current sources

- artifact contract:
  - `repository_scan.json`
  - `module_plan.json`
- DB:
  - `scan_jobs`
  - `scan_repository_tasks`

### Gap today

- repository scan contract is still `z.record(string, unknown)`
- there is no typed `Repository` payload schema yet

## 2. Module

Module is the result of repository partitioning and module scanning.

It should unify:

- module plan entry
- module scan result
- scan module task row

### Module payload

```ts
type Module = {
  id: string;
  scanJobId: string;
  repositoryId: string;
  moduleId: string;
  name: string;
  summary: string;
  artifactDir: string;
  pathListFile: string;
  priority: number;
  importantFiles: string[];
  entryPoints: string[];
  trustBoundaries: string[];
  attackSurfaces: string[];
  vulnerabilityThemes: string[];
  notes: string[];
}
```

### Module task metadata

```ts
type ModuleTaskMeta = {
  taskId: string;
  status: "queued" | "running" | "completed" | "failed";
  attempt: number;
  containerName: string | null;
  threadId: string | null;
  moduleScanMdPath: string | null;
  moduleScanJsonPath: string | null;
  functionPlanJsonPath: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}
```

### Current sources

- artifact contract:
  - `module_plan.json`
  - `module_scan.json`
- DB:
  - `scan_module_tasks`

### Gap today

- `module_plan.contract.ts` contains only planning fields
- `module_scan.contract.ts` is still effectively untyped
- DB stores only a thin task row, not a normalized module payload

## 3. Function

Function is the result of module planning for downstream function scanning.

It should unify:

- function plan task
- function task row

### Function payload

```ts
type Function = {
  id: string;
  scanJobId: string;
  repositoryId: string;
  moduleTaskId: string;
  moduleId: string;
  moduleName: string;
  functionId: string;
  functionName: string;
  filePath: string | null;
  line: number | null;
  priority: number;
  summary: string | null;
  riskType: string | null;
  score: number | null;
}
```

### Function task metadata

```ts
type FunctionTaskMeta = {
  taskId: string;
  status: "queued" | "running" | "completed" | "failed";
  attempt: number;
  containerName: string | null;
  threadId: string | null;
  functionScanMdPath: string | null;
  functionScanJsonPath: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}
```

### Current sources

- artifact contract:
  - `function_plan.json`
- DB:
  - `scan_function_tasks`

### Gap today

- `function-plan.contract.ts` still allows many legacy aliases:
  - `functionId | id`
  - `functionName | name`
  - `filePath | path`
  - `line | startLine`
- to unify cleanly, this contract should be normalized to one canonical shape

## 4. Candidate

Candidate is the output of function scanning.

It should unify:

- `function_result.json`
- `vulnerability_candidates`

### Candidate payload

```ts
type Candidate = {
  id: string;
  scanJobId: string;
  repositoryId: string;
  moduleTaskId: string | null;
  functionTaskId: string | null;
  functionId: string | null;
  title: string;
  description: string;
  filePath: string | null;
  line: number | null;
  confidence: number | null;
  score: number | null;
}
```

### Candidate execution metadata

```ts
type CandidateMeta = {
  status: "queued" | "running" | "completed" | "failed";
  currentStage: "analyzing" | "verifying";
  analysisThreadId: string | null;
  verifierThreadId: string | null;
}
```

### Current sources

- artifact contract:
  - `function_result.json`
- DB:
  - `vulnerability_candidates`

### Gap today

- candidate currently lives outside the task-table pattern
- it is both a persisted result object and a workflow control row
- this is acceptable if `Candidate` is treated as its own domain object and analysis/verification each keep separate task tables

## 5. Analysis

Analysis is the result of candidate analysis.

It should unify:

- `analysis_result.json`
- `candidate_analysis_tasks`

### Analysis payload

```ts
type Analysis = {
  id: string;
  scanJobId: string;
  candidateId: string;
  result:
    | "real_vulnerability"
    | "likely_vulnerability"
    | "plausible_but_unproven"
    | "false_positive";
  summary: string;
  confidence: number | null;
  score: number | null;
  reportPath: string | null;
  runtimeSeconds: number | null;
}
```

### Analysis task metadata

```ts
type AnalysisTaskMeta = {
  taskId: string;
  status: "queued" | "running" | "completed" | "failed";
  attempt: number;
  containerName: string | null;
  threadId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}
```

### Current sources

- artifact contract:
  - `analysis_result.json`
- DB:
  - `candidate_analysis_tasks`

### Gap today

- this is already close to unified
- main missing step is to stop treating the row as a loosely aliased "result" and instead make `Analysis` a first-class object reconstructed from the task row

## 6. Verification

Verification is the result of candidate verification.

It should unify:

- `verification_result.json`
- `candidate_verification_tasks`

### Verification payload

```ts
type Verification = {
  id: string;
  scanJobId: string;
  candidateId: string;
  result:
    | "real_vulnerability"
    | "likely_vulnerability"
    | "plausible_but_unproven"
    | "false_positive"
    | "api_misuse";
  isBug: boolean | null;
  isSecurity: boolean | null;
  summary: string;
  confidence: number | null;
  score: number | null;
  reportPath: string | null;
  issueDraftPath: string | null;
  pocPath: string | null;
  dockerfilePath: string | null;
  runScriptPath: string | null;
  runtimeSeconds: number | null;
}
```

### Verification task metadata

```ts
type VerificationTaskMeta = {
  taskId: string;
  status: "queued" | "running" | "completed" | "failed";
  attempt: number;
  containerName: string | null;
  threadId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}
```

### Current sources

- artifact contract:
  - `verification_result.json`
- DB:
  - `candidate_verification_tasks`

### Gap today

- same as Analysis: this is already close, but still represented indirectly

## Recommended Stage Input Model

The end-state stage inputs should be business-object-first.

## Repository stage input

```ts
type RepositoryStageInput = {
  repository: Repository;
  task: RepositoryTaskMeta;
  execution: RepositoryExecutionContext;
}
```

## Module stage input

```ts
type ModuleStageInput = {
  repository: Repository;
  module: Module;
  task: ModuleTaskMeta;
  execution: ModuleExecutionContext;
}
```

## Function stage input

```ts
type FunctionStageInput = {
  repository: Repository;
  module: Module;
  function: Function;
  task: FunctionTaskMeta;
  execution: FunctionExecutionContext;
}
```

## Analysis stage input

```ts
type AnalysisStageInput = {
  repository: Repository;
  module: Module;
  function: Function;
  candidate: Candidate;
  analysis: Analysis;
}
```

Notes:

- here `analysis` is the task/result object for the analysis stage itself
- before the stage runs, only its task metadata may exist
- after completion, the same object also contains final result fields

## Verification stage input

```ts
type VerificationStageInput = {
  repository: Repository;
  module: Module;
  function: Function;
  candidate: Candidate;
  analysis: Analysis;
  verification: Verification;
}
```

Verification can be postponed from strict stage-input unification temporarily, but this is the target shape.

## How Contracts And DB Should Converge

For each object family:

1. define one canonical payload schema in `artifacts/contracts`
2. define one mapper between DB task row and payload object
3. define one mapper between payload object and artifact JSON
4. stop using loosely typed `record(string, unknown)` schemas
5. stop using legacy alias-per-field contract parsing where possible

## Concrete Convergence Map

### Repository

- replace generic `repositoryScanSchema = z.record(...)`
- define canonical `repositorySchema`
- persist its fields into `scan_repository_tasks` result columns, or into a dedicated JSONB/result payload column if you prefer

### Module

- make `module_plan` and `module_scan` converge into one canonical `Module` payload
- current DB row has only partial module information; either:
  - add more result columns
  - or add a `result` JSON column to `scan_module_tasks`

### Function

- normalize `function_plan.contract.ts` to canonical names only
- current `scan_function_tasks` already carries most payload fields needed for a `Function`

### Candidate

- normalize `function_result.contract.ts` candidate shape as canonical `Candidate` payload
- `vulnerability_candidates` already stores most of it

### Analysis

- `analysis_result.contract.ts` should become the canonical `Analysis` payload schema
- `candidate_analysis_tasks` already stores both task metadata and result payload

### Verification

- `verification_result.contract.ts` should become the canonical `Verification` payload schema
- `candidate_verification_tasks` already stores both task metadata and result payload

## Recommended Naming

Use these names consistently:

- `Repository`
- `Module`
- `Function`
- `Candidate`
- `Analysis`
- `Verification`

For execution envelope / task metadata:

- `RepositoryTask`
- `ModuleTask`
- `FunctionTask`
- `AnalysisTask`
- `VerificationTask`

For stage inputs:

- `RepositoryStageInput`
- `ModuleStageInput`
- `FunctionStageInput`
- `AnalysisStageInput`
- `VerificationStageInput`

Avoid:

- `*StageDeps`
- `*ResultPayload` as the primary domain type
- DB-row-shaped objects leaking directly as business objects

## Recommended Next Steps

1. Define canonical zod payload schemas for:
   - `Repository`
   - `Module`
   - `Function`
   - `Candidate`
   - `Analysis`
   - `Verification`
2. Rename current `*StageDeps` to `*StageInput`
3. Make stage inputs business-object-first, with task metadata clearly separated
4. Make `analysis-result.repo.ts` and `verification-result.repo.ts` return `Analysis` and `Verification`, not compatibility aliases
5. Decide whether Repository/Module/Function should:
   - store payload in explicit columns
   - or store canonical payload JSON in the task table

## Recommendation On Storage Strategy

For `Analysis` and `Verification`, current explicit columns are already reasonable.

For `Repository`, `Module`, and possibly `Function`, the cleanest short-term unification is:

- keep the existing execution columns
- add one canonical `result` JSON column to the corresponding task tables

This avoids forcing every evolving payload field into top-level SQL columns too early.

Suggested candidates:

- `scan_repository_tasks.result`
- `scan_module_tasks.result`
- optionally `scan_function_tasks.result`

Then:

- artifact JSON
- in-memory domain object
- DB persisted result

can all share the same schema.
