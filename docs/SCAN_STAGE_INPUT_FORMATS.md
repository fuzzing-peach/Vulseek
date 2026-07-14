# Scan Stage Input Formats

This document records the **current runtime stage input shapes** used by the scan pipeline in code.

It reflects the structures built in:

- `packages/server/src/services/scan.ts`
- `packages/server/src/services/scan/stages/*.stage.ts`

It does **not** describe older conceptual schemas or the skill prompt prose. It describes the actual objects passed into stage `run()` today.

## Conventions

- Every stage input includes a top-level `taskId`.
- Every stage input includes both:
  - business data needed by the stage
  - execution/runtime helpers needed to run the agent and persist artifacts
- Current code still names these types `*StageDeps`, but semantically they are stage input objects.

## 1. RepositoryProfileStage

Source:

- `packages/server/src/services/scan.ts`
- `packages/server/src/services/scan/stages/repository-profile.stage.ts`

Current shape:

```ts
type RepositoryProfileStageInput = {
  taskId: string;
  scanJob: ScanJob;
  executionContext: {
    scanAgentProfile: AgentProfileLike | null;
    projectName: string;
    serviceName: string;
  };
  repositoryRuntimeDir: string;
  runtimeRootInContainer: string;
  setupMarkdownPathInContainer: string;
  containerName: string;
  prepareRepository: (
    containerName: string,
  ) => Promise<PreparedRepositoryState>;
  buildPrompt: (
    repositoryState: PreparedRepositoryState,
  ) => Promise<string> | string;
  runSingleTurnAgentInContainer: (input: {
    scanJob: ScanJob;
    agentProfile: AgentProfileLike | null;
    containerName: string;
    codexHome: string;
    runtimeDirHost: string;
    runtimeRootInContainer: string;
    cwd: string;
    prompt: string;
    setupMarkdownPathInContainer?: string;
    setupMarkdown?: string;
  }) => Promise<unknown>;
  validateArtifacts: () => Promise<unknown>;
  syncScanModuleTasksFromPlanFile: () => Promise<ScanModuleTask[]>;
};
```

Field notes:

- `taskId`: currently `scanJob.repositoryTaskId || scanJob.scanJobId`
- `scanJob`: includes repository-level scan metadata and repository task linkage
- `repositoryRuntimeDir`: host artifact directory for repository stage
- `runtimeRootInContainer`: container-side runtime root for the stage
- `prepareRepository`: resolves checkout target state before prompt construction
- `validateArtifacts`: validates `repository_scan.*` and `module_plan.json`
- `syncScanModuleTasksFromPlanFile`: persists downstream module tasks from `module_plan.json`

## 2. IdentifyTargetStage

Source:

- `packages/server/src/services/scan.ts`
- `packages/server/src/services/scan/stages/identify-target.stage.ts`

Current shape:

```ts
type IdentifyTargetStageInput = {
  taskId: string;
  module: ScanModuleTask & {
    scanJob: ScanJob;
  };
  executionContext: {
    scanAgentProfile: AgentProfileLike | null;
    projectName: string;
    serviceName: string;
  };
  moduleRuntimeDir: string;
  runtimeRootInContainer: string;
  setupMarkdownPathInContainer: string;
  containerName: string;
  runSingleTurnAgentInContainer: (input: {
    scanJob: ScanJob;
    agentProfile: AgentProfileLike | null;
    containerName: string;
    codexHome: string;
    runtimeDirHost: string;
    runtimeRootInContainer: string;
    cwd: string;
    prompt: string;
    setupMarkdownPathInContainer?: string;
    setupMarkdown?: string;
    onThreadId?: (threadId: string) => Promise<void>;
  }) => Promise<unknown>;
  buildPrompt: () => string;
  transitions: ModuleStageTransitions<ScanModuleTask>;
  validateArtifacts: () => Promise<{ functionPlanMissing: boolean }>;
  ensureFunctionPlan: (scanModuleTask: ScanModuleTask) => Promise<void>;
  syncFunctionTasksFromPlanFile: (
    scanModuleTask: ScanModuleTask,
  ) => Promise<void>;
};
```

Field notes:

- `taskId`: `scanModuleTask.scanModuleTaskId`
- `module.scanJob`: joined parent scan job
- `moduleRuntimeDir`: host artifact directory for the module
- `buildPrompt`: uses repository/module runtime context already captured in closures
- `validateArtifacts`: checks `module_scan.*` and `function_plan.json`
- `ensureFunctionPlan`: currently server-side fallback gate for missing function plan
- `syncFunctionTasksFromPlanFile`: persists downstream function tasks from `function_plan.json`

## 3. ScanTargetStage

Source:

- `packages/server/src/services/scan.ts`
- `packages/server/src/services/scan/stages/scan-target.stage.ts`

Current shape:

```ts
type ScanTargetStageInput = {
  taskId: string;
  function: ScanFunctionTask & {
    scanJob: ScanJob;
    module: ScanModuleTask & {
      scanJob: ScanJob;
    };
  };
  executionContext: {
    scanAgentProfile: AgentProfileLike | null;
    projectName: string;
    serviceName: string;
  };
  functionRuntimeDir: string;
  runtimeRootInContainer: string;
  setupMarkdownPathInContainer: string;
  containerName: string;
  runSingleTurnAgentInContainer: (input: {
    scanJob: ScanJob;
    agentProfile: AgentProfileLike | null;
    containerName: string;
    codexHome: string;
    runtimeDirHost: string;
    runtimeRootInContainer: string;
    cwd: string;
    prompt: string;
    setupMarkdownPathInContainer?: string;
    setupMarkdown?: string;
    onThreadId?: (threadId: string) => Promise<void>;
  }) => Promise<unknown>;
  buildPrompt: () => string;
  transitions: FunctionStageTransitions;
  persistCandidatesFromArtifacts: () => Promise<unknown>;
};
```

Field notes:

- `taskId`: `scanFunctionTask.scanFunctionTaskId`
- `function.module.scanJob`: fully joined upstream context
- `functionRuntimeDir`: host artifact directory for the function
- `persistCandidatesFromArtifacts`: validates `function_result.json` and persists candidate records

## 4. AnalysisStage

Source:

- `packages/server/src/services/scan.ts`
- `packages/server/src/services/scan/stages/analyze-finding.stage.ts`

Current shape:

```ts
type AnalysisStageInput = {
  taskId: string;
  candidate: VulnerabilityCandidate & {
    candidateAnalysisTaskId?: string;
    scanJob: ScanJob;
    module: ScanModuleTask & {
      scanJob: ScanJob;
    };
    function: ScanFunctionTask & {
      scanJob: ScanJob;
      module: ScanModuleTask & {
        scanJob: ScanJob;
      };
    };
  };
  transitions: CandidateStageTransitions;
  buildPrompt: (input: {
    scanJob: ScanJob;
    scanModuleTask: ScanModuleTask;
    scanFunctionTask: ScanFunctionTask;
    candidate: VulnerabilityCandidate;
  }) => Promise<string>;
  runAnalysisAgent: (input: {
    vulnerabilityCandidateId: string;
    phase: "analysis";
    prompt: string;
  }) => Promise<unknown>;
};
```

Field notes:

- `taskId`: currently `candidateAnalysisTaskId` if present, otherwise `vulnerabilityCandidateId`
- `candidate`: carries the vulnerability candidate plus fully joined scan job/module/function context
- `candidateAnalysisTaskId`: currently attached during joined input construction
- this stage input is lighter than repository/module/function stage inputs because agent execution is currently delegated through `runAnalysisAgent`

## 5. VerifyingStage

Source:

- `packages/server/src/services/scan.ts`
- `packages/server/src/services/scan/stages/verify-finding.stage.ts`

Current shape:

```ts
type VerificationStageInput = {
  taskId: string;
  analysisResult: AnalysisResult & {
    candidateVerificationTaskId?: string;
    scanJob: ScanJob;
    module: ScanModuleTask & {
      scanJob: ScanJob;
    };
    function: ScanFunctionTask & {
      scanJob: ScanJob;
      module: ScanModuleTask & {
        scanJob: ScanJob;
      };
    };
    candidate: VulnerabilityCandidate & {
      candidateAnalysisTaskId?: string;
      scanJob: ScanJob;
      module: ScanModuleTask & {
        scanJob: ScanJob;
      };
      function: ScanFunctionTask & {
        scanJob: ScanJob;
        module: ScanModuleTask & {
          scanJob: ScanJob;
        };
      };
    };
  };
  transitions: CandidateStageTransitions;
  buildPrompt: (input: {
    scanJob: ScanJob;
    scanModuleTask: ScanModuleTask;
    scanFunctionTask: ScanFunctionTask;
    candidate: VulnerabilityCandidate;
    analysisResult: AnalysisResult;
  }) => Promise<string>;
  runVerifierAgent: (input: {
    vulnerabilityCandidateId: string;
    prompt: string;
  }) => Promise<unknown>;
};
```

Field notes:

- `taskId`: currently `candidateVerificationTaskId` if present, otherwise `vulnerabilityCandidateId`
- `analysisResult`: carries prior analysis output plus fully joined candidate/function/module/job context
- this stage is downstream of analysis and depends on the persisted analysis result already existing

## Summary Table

| Stage | Primary business object | `taskId` source | Has joined upstream context | Has container/runtime execution fields |
| --- | --- | --- | --- | --- |
| `RepositoryProfileStage` | `scanJob` | `repositoryTaskId` | no nested join beyond `scanJob` | yes |
| `IdentifyTargetStage` | `module` | `scanModuleTaskId` | `module.scanJob` | yes |
| `ScanTargetStage` | `function` | `scanFunctionTaskId` | `function.module.scanJob` | yes |
| `AnalysisStage` | `candidate` | `candidateAnalysisTaskId` fallback candidate id | `candidate.function.module.scanJob` | no direct container fields |
| `VerifyingStage` | `analysisResult` | `candidateVerificationTaskId` fallback candidate id | `analysisResult.candidate.function.module.scanJob` | no direct container fields |

## Current Observations

- The current `*StageDeps` names are misleading. These are stage input objects, not just dependency bundles.
- Repository/module/function inputs include runtime execution helpers directly.
- Analysis/verification inputs are more business-object-centric and delegate agent execution through narrower callback functions.
- `AnalysisStage` and `VerifyingStage` still allow fallback from task-table ids to candidate ids when the task row has not been fully materialized.
- A cleaner end state would rename these shapes to `*StageInput` and eliminate the fallback-to-candidate-id behavior.
