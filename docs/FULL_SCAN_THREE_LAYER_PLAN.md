# Full Scan Three-Layer Refactor Plan

## Goal

Refactor full-scan from:

- one main LLM agent that internally spawns subagents

to:

- Vulseek-programmed multi-stage orchestration with independent containers and agent processes

The new full-scan pipeline uses three explicit agent roles:

1. `repository-scanner`
2. `module-scanner`
3. `function-scanner`

Only `function-scanner` emits final `candidate` events.

The first two layers write scan result files that become shared context for the next layer.

## Design Principles

1. Vulseek, not the LLM, owns task decomposition and scheduling.
2. Every task runs in its own fresh container and process.
3. Each layer writes durable artifacts into the project/profile context directory.
4. Higher-level scan results become structured context for lower-level scanners.
5. Final candidate emission happens only at function level.
6. Queueing, concurrency, retry, timeout, and recovery are controlled programmatically.
7. The system should prefer coverage and uniformity over a small hand-picked top-N set.

## High-Level Workflow

### Stage 1: Repository Scan

Vulseek starts one `repository-scanner`.

Responsibilities:

- inspect repository structure
- identify languages and toolchains
- identify build systems
- identify runtime vs non-runtime directories
- identify attack surfaces and common vulnerability classes worth prioritizing
- partition the repository into functional modules

Outputs:

- `repository_scan.md`
- `repository_scan.json`
- `module_plan.json`

### Stage 2: Module Scan

Vulseek reads `module_plan.json` and starts one `module-scanner` per module.

Responsibilities:

- understand module responsibility
- identify module entry points and trust boundaries
- identify important files and local vulnerability themes
- enumerate functions that should be scanned
- write module-level context for downstream function scanners

Outputs per module:

- `module_scan.md`
- `module_scan.json`
- `function_plan.json`

### Stage 3: Function Scan

Vulseek reads every `function_plan.json` and starts one `function-scanner` per function task.

Responsibilities:

- inspect one function with repository-level and module-level context
- identify concrete candidate locations inside the function or its immediate local flow
- assign a score
- emit `candidate` or `candidate_batch` through `VULSEEK_EVENT`

Outputs per function:

- optional local file artifacts such as `function_scan.md`
- mandatory structured event output when candidates exist

## Agent Responsibilities

### `repository-scanner`

Must produce a repository-wide view, not final findings.

It should answer:

- what is the repository for
- what are the main runtime components
- what languages are in use
- what build systems and module boundaries exist
- what directories should be skipped or down-ranked
- what external input surfaces exist
- what vulnerability classes are likely to matter here
- how the repository should be partitioned into scan modules

It must not emit final candidates.

### `module-scanner`

Must produce a module-wide view, not final findings.

It should answer:

- what this module does
- what security-relevant role it has
- what public or externally reachable entry points it exposes
- what local attack surface exists
- what files matter most
- what functions should be scanned one by one
- what vulnerability themes should be emphasized inside this module

It must not emit final candidates.

### `function-scanner`

Must inspect one function task at a time.

It should answer:

- whether the function is security-sensitive
- whether there are concrete candidate locations inside or immediately downstream of the function
- what kind of issue each candidate suggests
- how strong the candidate is

It is the only layer allowed to emit:

- `candidate`
- `candidate_batch`

## Context Artifacts

### Repository-Level Files

Suggested location:

- `scanning/full-scan/repository/`

Required files:

- `repository_scan.md`
- `repository_scan.json`
- `module_plan.json`

`repository_scan.json` should contain structured fields such as:

- repository summary
- languages
- build systems
- runtime directories
- skipped directories
- attack surfaces
- vulnerability themes
- notes about external components

`module_plan.json` should contain:

- module id
- module name
- summary
- directory/file scope
- primary language
- priority

### Module-Level Files

Suggested location:

- `scanning/full-scan/modules/<module-id>/`

Required files:

- `module_scan.md`
- `module_scan.json`
- `function_plan.json`

`module_scan.json` should contain:

- module name
- module summary
- important files
- entry points
- trust boundaries
- local attack surfaces
- vulnerability themes
- screening notes

`function_plan.json` should contain one task per function with fields such as:

- function id
- function name
- file path
- line
- language
- short summary
- why this function should be scanned
- optional local context hints

### Function-Level Files

Suggested location:

- `scanning/full-scan/modules/<module-id>/functions/<function-id>/`

Optional files:

- `function_scan.md`
- `function_scan.json`

Required event behavior:

- emit `candidate` or `candidate_batch` when concrete candidates exist

## Event Contract

### Repository Layer

No final candidate events.

Possible future internal event types if needed:

- `module_plan`

But phase 1 can rely only on output files and Vulseek file reading.

### Module Layer

No final candidate events.

Possible future internal event types if needed:

- `function_plan`

But phase 1 can rely only on output files and Vulseek file reading.

### Function Layer

Allowed final events:

- `candidate`
- `candidate_batch`

Candidate payload should continue using the existing schema:

- `title`
- `description`
- `filePath`
- `line`
- `confidence`
- `reportPath`

Vulseek should enrich the stored candidate record with:

- `scanJobId`
- `moduleName`
- `functionName`
- `sourceStage = function-scanner`

## Queue Model

The current full-scan should be changed into three explicit programmatic queues.

### 1. Repository Queue

One task per full-scan job.

Output:

- `module_plan.json`

### 2. Module Queue

One task per module from `module_plan.json`.

Output:

- `function_plan.json`

### 3. Function Queue

One task per function from all module plans.

Output:

- candidate events

Vulseek should keep per-queue concurrency caps as constants first, then move to config later.

Recommended initial constants:

- repository scanner concurrency: `1`
- module scanner concurrency: `4`
- function scanner concurrency: `8`

The exact values can be tuned later.

## Status Model

Full-scan job status should become:

1. `queued`
2. `repository_scanning`
3. `module_scanning`
4. `function_scanning`
5. `analyzing`
6. `verifying`
7. `completed`
8. `failed`

Recommended per-task statuses:

- `queued`
- `running`
- `completed`
- `failed`

Recommended progress counters:

- modules total / completed / failed
- functions total / completed / failed
- candidates emitted

## Container Model

Every scanner task runs in a fresh container:

- repository-scanner container
- module-scanner container
- function-scanner container

Common rules:

- start from the checkout image
- mount only the current project/profile context subtree
- mount only the minimal job-specific subtree needed by the scanner
- pass configured container environment
- delete container after task completion
- also clean up in `finally`

Container naming should remain deterministic and include the task identity.

## Why This Refactor Is Better

Compared with LLM-managed subagent spawning, this design gives Vulseek:

1. deterministic queue control
2. deterministic concurrency control
3. explicit retries and timeout handling
4. clearer progress tracking
5. more uniform scan depth
6. better artifact structure
7. less dependence on Codex internal collab behavior

It also makes it easier to:

- change prompts per layer
- change model/profile per layer
- rerun only failed modules or functions
- prioritize or shard tasks later

## Main Risks

### 1. Too Many Function Tasks

Large repositories may produce too many function tasks.

Mitigation:

- restrict scope to runtime code first
- skip docs, tests, examples, generated files by default
- allow module-scanner to omit clearly irrelevant functions
- add configurable limits later if needed

### 2. Weak Function Context

A function-scanner can become too local.

Mitigation:

- always provide `repository_scan` and `module_scan`
- include nearby code
- include caller/callee hints when available

### 3. Excessive Noise

Function-level scanning may produce too many weak candidates.

Mitigation:

- require a score
- persist all candidates but allow later thresholds
- push final validation to analysis/verify rather than over-pruning in full-scan

## Proposed Implementation Phases

### Phase 1

Replace LLM internal spawn with programmatic `repository-scanner` and `module-scanner`.

Deliverables:

- `repository-scanner` prompt/skill
- `module-scanner` prompt/skill
- repository task runner
- module task runner
- `repository_scan.*`
- `module_scan.*`
- `module_plan.json`
- `function_plan.json`

At this phase, function scanning can still be stubbed or limited.

### Phase 2

Introduce programmatic `function-scanner`.

Deliverables:

- function task runner
- `function-scanner` prompt/skill
- queue creation from `function_plan.json`
- function-level artifacts
- function-level candidate event ingestion

### Phase 3

Integrate full UI status and observability.

Deliverables:

- repository/module/function progress views
- in-progress module list
- in-progress function list
- per-function live agent output
- candidate count growth during full-scan

### Phase 4

Optimize task quality and scheduling.

Deliverables:

- better module partitioning
- better function prioritization
- rerun failed tasks only
- configurable concurrency
- optional agent-profile per layer

## Testing Plan

Old full-scan behavior does not need dedicated regression coverage here.

### Unit Tests

1. repository plan parser
- parse valid `module_plan.json`
- reject malformed module plans

2. module plan parser
- parse valid `function_plan.json`
- reject malformed function plans

3. candidate event ingestion
- function-scanner candidate event creates DB candidates correctly
- malformed event is rejected with debug logging

4. queue transitions
- repository complete -> module queue creation
- all modules complete -> function queue creation
- function candidate events -> candidate records created

### Integration Tests

1. repository-scanner end-to-end
- run one full-scan job
- verify `repository_scan.md/json` and `module_plan.json` are written

2. module-scanner end-to-end
- verify one module task writes `module_scan.md/json` and `function_plan.json`

3. function-scanner end-to-end
- verify one function task emits candidate event
- verify candidate is stored and visible in UI/API

4. full pipeline smoke test
- one small repository
- repository -> module -> function
- at least one candidate successfully created

5. failure handling
- malformed `module_plan.json`
- malformed `function_plan.json`
- failed module task
- failed function task
- verify job state and retryability are correct

### UI Tests

1. full-scan job detail shows:
- repository scan progress
- module scan progress
- function scan progress

2. files tab shows:
- repository artifacts
- module artifacts
- function artifacts

3. candidates update while function-scanners emit events

## Recommended Initial File Layout

```text
projects/<Project>/profiles/<Profile>/jobs/<ScanJobId>/
  scanning/
    full-scan/
      repository/
        repository_scan.md
        repository_scan.json
        module_plan.json
      modules/
        <module-id>/
          module_scan.md
          module_scan.json
          function_plan.json
          functions/
            <function-id>/
              function_scan.md
              function_scan.json
```

## Immediate Next Step

Implement phase 1 first:

1. add `repository-scanner` skill
2. add `module-scanner` skill
3. replace LLM internal full-scan subagent spawning with Vulseek-driven repository/module task orchestration
4. make `function_plan.json` the boundary between phase 1 and phase 2
