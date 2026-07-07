# Sandbox Agent Migration Plan

## Goal

Replace Vulseek's current agent runtime layer with `sandbox-agent`, while keeping Vulseek's business orchestration unchanged.

This migration is specifically about replacing:

- provider-specific agent launch logic
- detached Codex driver management
- runtime event/session handling
- streaming collection from running agent processes

This migration does **not** change Vulseek's ownership of:

- scan / analysis / verify queue orchestration
- database state machines
- artifact directory layout
- retry / recovery policy
- candidate / analysis / verification business semantics

## Target Architecture

### Vulseek Responsibilities

Vulseek remains the orchestrator and source of business truth.

It continues to own:

- `scan_jobs`, `scan_module_tasks`, `scan_function_tasks`
- `vulnerability_candidates`, `analysis_results`, `verification_results`
- BullMQ / Redis queues
- per-job and per-candidate artifact directories
- task retries, stale cleanup, and failure handling
- progress computation for the UI

### Agent Container Responsibilities

Each agent task still runs in its own container.

The container will:

- mount the existing `/scan-context`
- start `sandbox-agent`
- run the selected provider through `sandbox-agent`
- expose universal runtime events
- write transcript/event output into the mounted artifact directory

### Sandbox Agent Responsibilities

`sandbox-agent` becomes the runtime abstraction for:

- Codex
- Claude Code
- future SWE agents if needed

It should provide:

- session lifecycle
- turn lifecycle
- normalized universal events
- provider-specific execution under one runtime API

## Core Principle

Vulseek should stop defining its own bottom-layer runtime protocol.

Instead:

1. use `sandbox-agent` universal events as the runtime transcript format
2. keep only Vulseek-specific business payloads for scan results

That means:

- no new Vulseek JSON-RPC protocol
- no provider-specific frontend protocol
- no Python driver for Codex app-server

Vulseek still needs a small set of domain payloads, such as:

- candidate found
- analysis result
- verification result
- module plan ready
- function plan ready

These are business results, not runtime transport events.

## Current Runtime To Replace

The current runtime implementation is centered in:

- [scan.ts](packages/server/src/services/scan.ts)

The primary replacement targets are:

- `launchDetachedCodexAppServerDriverInContainer`
- `CODEX_APP_SERVER_DRIVER_PY`
- `runSingleTurnAgentInContainer`
- provider-specific launch branches inside scan / analysis / verify runners

The current business entrypoints that should remain, but switch to the new runtime, are:

- `runRepositoryScannerInContainer`
- `runModuleScannerTaskInContainer`
- `runFunctionScannerTaskInContainer`
- `runCandidateAnalysisAgentInContainer`
- `runCandidateVerifierInContainer`

## Runtime Contract After Migration

Vulseek should interact with `sandbox-agent` through a thin internal runtime adapter.

Suggested runtime adapter responsibilities:

- start sandbox-agent-backed task session
- subscribe to runtime event stream
- persist transcript to artifact files
- surface process exit / timeout / connection failures
- support monitoring recovery after Vulseek restart

Suggested internal methods:

- `startSandboxAgentTask()`
- `streamSandboxAgentEvents()`
- `stopSandboxAgentTask()`
- `recoverSandboxAgentTaskMonitoring()`

These method names are illustrative; the important part is the separation of runtime concerns from scan business logic.

## Event Strategy

### Runtime Events

Runtime events should come directly from `sandbox-agent`.

Vulseek should persist them as raw transcript records, for example:

- `sandbox-agent-events.jsonl`

The raw event file should be the canonical runtime transcript used for:

- UI streaming
- restart recovery
- debugging agent failures

### Business Payloads

Vulseek should continue to parse a thin business payload from agent output.

Recommended approach:

- keep a single structured bridge payload format
- parse it from assistant text output
- do not parse it from command execution examples or shell echoes

Typical business payload kinds:

- `candidate`
- `candidate_batch`
- `analysis_result`
- `verification_result`
- `module_plan`
- `function_plan`

## Artifact Layout

The existing artifact directory layout should remain stable.

Only the runtime transcript files should change.

Recommended additions:

- job-level scan runtime transcript:
  - `scanning/sandbox-agent-events.jsonl`
- module scanner runtime transcript:
  - `scanning/modules/<moduleTaskId>/sandbox-agent-events.jsonl`
- function scanner runtime transcript:
  - `scanning/functions/<functionTaskId>/sandbox-agent-events.jsonl`
- candidate analysis runtime transcript:
  - `candidates/<candidateId>/analysis-sandbox-agent-events.jsonl`
- candidate verify runtime transcript:
  - `candidates/<candidateId>/verify-sandbox-agent-events.jsonl`

Business output files remain unchanged:

- analysis report
- verify report
- issue draft
- module summary
- function plan

## Migration Phases

### Phase 1: Introduce Sandbox Agent Runtime Layer

Add a new internal runtime adapter without changing business orchestration.

Scope:

- create a new runtime module under `packages/server/src/services/`
- encapsulate container startup and `sandbox-agent` session startup
- persist raw universal events to file
- keep current scan business functions intact

Suggested new files:

- `packages/server/src/services/sandbox-agent/runtime.ts`
- `packages/server/src/services/sandbox-agent/types.ts`
- `packages/server/src/services/sandbox-agent/persistence.ts`

Deliverable:

- a reusable runtime API that can replace the current Codex driver path

### Phase 2: Migrate Analysis Runtime

Replace the runtime inside:

- `runCandidateAnalysisAgentInContainer`

Keep unchanged:

- prompt construction
- result parsing
- DB updates
- queue orchestration

Success criteria:

- analysis task still writes report and result
- candidate detail page receives runtime streaming
- retry still works
- Vulseek restart can resume monitoring or fail cleanly

### Phase 3: Migrate Verification Runtime

Replace the runtime inside:

- `runCandidateVerifierInContainer`

Keep unchanged:

- verify queue semantics
- verification result writing
- candidate verify page behavior

Success criteria:

- verify transcript is visible in UI
- verification result persists correctly
- stale running task recovery remains correct

### Phase 4: Migrate Repository Scanner Runtime

Replace the runtime inside:

- `runRepositoryScannerInContainer`

Keep unchanged:

- repository artifact outputs
- module-plan generation responsibilities
- scan job state transitions

Success criteria:

- repo scanner events stream in the scanning tab
- repository overview artifacts still exist
- downstream module scheduling still starts correctly

### Phase 5: Migrate Module and Function Scanner Runtime

Replace the runtime inside:

- `runModuleScannerTaskInContainer`
- `runFunctionScannerTaskInContainer`

Keep unchanged:

- task creation and queueing
- candidate creation flow
- immediate analysis scheduling on candidate arrival

Success criteria:

- module/function scanner streaming is visible
- candidate events are still parsed
- progress bars reflect true runtime progress

### Phase 6: Remove Legacy Runtime Code

After all stages run on `sandbox-agent`, delete legacy runtime code:

- detached Codex driver launcher
- app-server-specific state handling
- Python driver script
- legacy runtime cursor/state files that only exist for the old driver path

## Frontend Streaming Plan

The frontend should continue to connect only to Vulseek, not directly to containers.

Vulseek should:

1. read persisted runtime transcript files
2. maintain in-memory buffers per transcript file
3. expose SSE to the browser with snapshot + delta semantics

This keeps:

- one stable frontend protocol
- restart recovery on the server side
- no direct browser dependency on container liveness

The current scan/candidate streaming endpoints should be preserved at the API boundary, while their underlying file source changes from legacy app-server JSONL to sandbox-agent transcript JSONL.

## Container Image Changes

The checkout image should include:

- `sandbox-agent`
- `codex`
- `claude`
- `serena`
- `clangd`

Container startup should:

- start `sandbox-agent`
- point its working directory at the mounted repo in `/scan-context`
- ensure transcript files are written to mounted artifact directories

## Settings Model

Global and profile-level settings should keep selecting the provider:

- `codex`
- `claude_code`

The selected provider should be passed into the sandbox-agent runtime adapter.

No new provider-specific business logic should be added to scan orchestration.

Provider-specific behavior should stay contained inside the runtime layer.

## Database Impact

This migration should minimize schema churn.

Existing business tables are sufficient for most of the work.

Optional new columns if needed for recovery and observability:

- `runtimeSessionId`
- `runtimeContainerId`
- `runtimeProvider`
- `runtimeStartedAt`
- `runtimeLastEventAt`

These are operational metadata fields, not business-semantic fields.

## Recovery Model

Vulseek restart should not immediately requeue all running tasks.

On startup:

1. find tasks marked `running`
2. inspect whether their containers are still alive
3. if alive, restore transcript monitoring
4. if dead, mark task `failed` and leave retry to normal controls

This is critical to avoid duplicate analysis or verification runs.

## Risks

### Risk 1: Treating Sandbox Agent as the Orchestrator

This would be a design mistake.

`sandbox-agent` should only replace the runtime layer, not task orchestration.

### Risk 2: Leaking Provider Differences Into UI

If the UI starts depending on provider-specific raw event shapes, the migration will fail architecturally.

Only Vulseek should see provider/runtime details.

### Risk 3: Mixing Runtime Events With Business Payloads

These must stay separate:

- runtime transcript from `sandbox-agent`
- business payloads parsed by Vulseek

### Risk 4: Regressing Retry/Recovery Semantics

The migration should keep strong consistency for:

- failed task retry
- stale active task cleanup
- restart monitoring recovery

## Acceptance Criteria

The migration is complete when:

1. scan, analysis, and verify all run through `sandbox-agent`
2. no legacy detached Codex driver path remains
3. browser streaming still works through Vulseek SSE
4. restart recovery does not lose task visibility
5. business outputs remain compatible with existing pages and DB records

## Recommended Implementation Order

Implement in this order:

1. sandbox-agent runtime adapter
2. analysis
3. verification
4. repository scanner
5. module scanner
6. function scanner
7. legacy runtime removal

This order minimizes blast radius and gives fast validation on the most isolated task types first.
