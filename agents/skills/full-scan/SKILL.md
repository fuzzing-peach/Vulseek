---
name: full-scan
description: Run a repository-wide full scan through a main-agent and scan-subagent workflow. The main agent partitions the repository into modules, gives each subagent minimal shared context, collects module-level security-sensitive candidates, performs global deduplication and prioritization, and then writes final candidates to a JSON result file.
---

# Full Scan

Use this skill when Vulseek asks you to perform a full scan over the latest repository state.

Unlike `delta-scan`, this skill is not commit-driven. It is repository-driven.

Your job is not to prove that a vulnerability exists. Your job is to identify all code locations that are security-relevant enough to deserve later deep analysis.

This skill uses a two-layer workflow:

- one main agent
- multiple scan subagents

The main agent owns repository modeling, module partitioning, shared context generation, result aggregation, global prioritization, deduplication, and final `scan_candidates.json` writing.

Scan subagents own module-level security-sensitive screening only.

## Required Result JSON

After all module outputs are aggregated, the main agent must write a JSON file such as `scan_candidates.json`.

The result JSON must be one top-level object:

```json
{
  "candidates": [
    {
      "title": "Candidate title",
      "description": "Why this location is worth deeper analysis",
      "filePath": "src/example.c",
      "line": 88,
      "confidence": 0.76,
      "score": 6.2
    }
  ]
}
```

Rules:

- always include `candidates`
- use `[]` when no candidate survives aggregation
- each candidate may contain only `title`, `description`, `filePath`, `line`, `confidence`, and `score`
- if the runtime provides a `write_result_json_to` path, write the JSON there
- when possible, write atomically: write a temporary file first, then rename it into place
- do not emit any structured stdout protocol

Only the main agent may write the final result file.

Scan subagents must not write final merged candidates directly.

## High-Level Objective

For the current repository snapshot:

1. build a lightweight repository model
2. partition the repository into modules
3. give each scan subagent one module plus minimal shared context
4. let each scan subagent identify security-sensitive candidate locations inside its module
5. collect all module outputs
6. merge, deduplicate, correlate, and prioritize candidates globally
7. write the final candidate list to `scan_candidates.json`

## Output Philosophy

At the full-scan stage, a candidate means:

- the location is security-relevant
- it is worth later deep analysis
- it may represent a dangerous function, a critical decision point, a missing check, or an inconsistent security handling pattern
- it does not need to be a proven vulnerability yet

Recall matters more than precision, but the main agent must still remove obvious noise before writing the final result file.

## Repository Scope

Prioritize real runtime code.

Usually high-priority areas include:

- protocol parsing
- decoding
- file loading
- IPC handling
- public library APIs
- authentication / authorization / signature verification
- state machines
- memory and resource management
- lifecycle management
- callback registration and invocation
- concurrency, locking, and shared state
- error handling and rollback paths

Usually lower-priority areas include:

- docs
- comments
- tests unless they reveal real runtime API contracts
- generated code unless it is executed as part of the product
- vendored third-party code unless the runtime explicitly asks to include it

## Main Agent Workflow

The full-scan main agent should work in four phases.

### Phase 1 - Lightweight Repository Analysis

Before starting any scan subagent, perform a lightweight repository pass.

Do not do deep vulnerability analysis here.

Do only enough work to understand repository structure and produce a module plan.

Tasks:

1. read the top-level directory structure
2. identify the build system and its module boundaries
3. identify core runtime directories
4. identify directories to skip or down-rank
5. identify major public APIs, major entry surfaces, and major shared infrastructure
6. partition the repository into modules

Module partitioning may use:

- directory layout
- CMake subdirectories, targets, libraries, modules
- Go packages
- Java modules or packages
- public header vs private implementation boundaries
- explicit build-script component boundaries

A module should be large enough to preserve local semantics, but small enough to be reviewed by one scan subagent.

Recommended artifacts:

- `01_repository_layout.md`
- `02_module_plan.json`
- `02_module_plan.md`
- `02_shared_context.md`

### Phase 2 - Prepare Minimal Shared Context

Each scan subagent must receive:

- the assigned module boundary
- the module file list
- a short repository-level summary
- the main build-system and module boundaries
- identified core source directories
- down-ranked or skipped directories
- likely attack-surface categories
- major public APIs, entry points, and shared infrastructure locations
- a clear instruction that this stage is only security-sensitive screening, not deep confirmation

The purpose of shared context is to stop subagents from becoming blind local readers with no repository-level understanding.

### Phase 3 - Run Scan Subagents

You must create one scan subagent per module.

Subagent spawning is mandatory for full scan. Do not replace subagents with a sequential single-agent emulation.

Run at most 4 scan subagents concurrently. If there are more than 4 modules, queue them and continue as slots free up.

Each scan subagent must use the installed skill named `full-scan-subagent`.

Each scan subagent must use the same model and the same reasoning effort as the main agent. Do not downgrade, upgrade, or switch models when spawning subagents.

Each subagent should return a module report or structured candidate draft list to the main agent.

Scan subagents must not do deep reachability proof, exploit confirmation, or final merged candidate writing.

### Phase 4 - Aggregate and Write Final Candidates

After all module scans complete, the main agent must:

1. read every module `02_candidate_drafts.json`
2. validate that each module output follows the fixed subagent schema
3. merge duplicate candidate drafts
4. merge multiple reasons pointing to the same location
5. do lightweight cross-module correlation
6. identify obvious noise and remove it
7. prioritize candidates globally
8. write the main full-scan report
9. write final candidates to `scan_candidates.json`

## Subagent Output Contract

Every scan subagent must write `02_candidate_drafts.json` using the fixed schema defined by `full-scan-subagent`.

The main agent should assume this structure:

```json
{
  "module": {
    "name": "tls-handshake",
    "summary": "Implements TLS handshake state transitions and related message parsing.",
    "entryPoints": [
      "DoTlsHandshake",
      "ProcessClientHello"
    ]
  },
  "candidates": [
    {
      "title": "Missing state validation before handshake transition",
      "description": "Handshake transition appears security-sensitive and may lack a required state gate.",
      "filePath": "src/tls/handshake.c",
      "line": 214,
      "confidence": 0.78,
      "sensitivityType": "security_decision",
      "reasonCategory": "missing_security_logic",
      "reason": "Module handles untrusted protocol messages and this transition appears to bypass the state check used in sibling paths."
    }
  ],
  "notes": [
    "Did not inspect generated files under src/generated/."
  ]
}
```

At minimum, the main agent should read:

- `module.name`
- `module.summary`
- `module.entryPoints`
- `candidates`
- `notes`

If a module file is malformed, the main agent should not silently trust it. It should either:

- repair obvious formatting issues if safe to do so
- or skip the malformed module output and record that in the main report

## Main-Agent Aggregation Rules

When aggregating all module outputs, follow this order:

1. read all module `02_candidate_drafts.json` files
2. flatten all `candidates` into one working set
3. attach module context from `module.name` and `module.summary`
4. perform initial deduplication using a concrete location key such as:
   - `filePath + line + title`
   - or `filePath + title` when `line` is unavailable
5. merge multiple reasons for the same candidate
6. merge repeated observations from different modules when they point to the same public/shared function
7. keep track of which modules reported the same candidate
8. perform lightweight cross-module correlation
9. remove obvious noise
10. apply the global prioritization rules
11. write final candidate JSON only after the merged list is stable

When merging duplicates, preserve:

- strongest confidence
- all materially distinct reasons
- all reporting modules
- any useful module-level notes that help explain missing logic or inconsistency

## Scan Subagent Instructions

Each scan subagent is responsible for one module.

Its job is to identify all candidate locations in that module that are security-relevant enough for later deep analysis.

A scan subagent works in three phases.

### Subagent Phase 1 - Understand Module Responsibility

Quickly read enough code to understand:

- what role the module plays in the project
- what functionality it implements
- what interfaces it exposes externally

Output:

- a one- or two-sentence module responsibility summary
- the main module interfaces or entry points

This is context for later judgments. Do not spend too much time here.

### Subagent Phase 2 - Function-by-Function Screening

Traverse the module's functions and do a fast security-sensitivity judgment.

For each function, ask:

- does it receive or process externally controllable input?
- does it make a security-relevant decision?
- does it call potentially dangerous operations?
- does it perform input validation, boundary checks, permission checks, state checks, resource handling, lifecycle handling, or concurrency control?

If the function is security-sensitive, record:

- location
- sensitivity type
- short reason for marking it

If the function is clearly not security-relevant, skip it.

Do not fully reverse-engineer the whole function. Use fast judgment based on:

- function signature
- key lines
- obvious callees and callers
- nearby checks and operations

### Subagent Phase 3 - Module-Level Observations

After function-level screening, do one more pass from the module-level perspective.

Look for signals that are hard to see from a single-function view.

Focus on two classes of signals:

1. missing security logic that should exist given the module's responsibility
2. inconsistent security handling across similar functions in the same module

These module-level observations should also be returned as candidate drafts.

## What Counts As Security-Sensitive

Mark a location when it is close to any of the following:

- external input handling
- parsing or decoding
- authentication, authorization, signature verification, certificate validation
- permissions or policy decisions
- trust-boundary transitions
- state-machine transitions
- boundary checks, length checks, offset checks, integer checks
- memory ownership, allocation, free, reuse, pointer lifetime
- file, socket, IPC, process, thread, lock, callback, allocator, or `FILE*` lifecycle
- cleanup, rollback, teardown, error handling
- shared global state, locking, synchronization, races, cross-thread visibility

Examples of lower-priority signals:

- pure logging
- formatting only
- cosmetic conversions
- clearly inert wrappers with no policy or dangerous side effects

Lower priority does not always mean ignore. Use judgment.

## Candidate Draft Quality Rules

A module candidate draft should point to a concrete location or a concrete missing/inconsistent pattern.

Good candidate draft forms include:

- a security-sensitive function
- a security-critical decision point
- a dangerous sink that should be examined later
- a missing validation or missing state check implied by module responsibility
- an inconsistency across similar functions or related modules

Each candidate draft should carry, when known:

- title
- short description
- file path
- line
- rough confidence
- module name
- reason category

Description should stay short and structural.

Put longer supporting reasoning into the module report, not into the final merged candidate JSON.

## Global Prioritization Rules For The Main Agent

After collecting all module outputs, prioritize candidates in descending order using a combination of the following factors.

### 1. Exposure

How close is the location to external input?

Higher priority:

- network input
- file input
- IPC
- config input
- public API entry

### 2. Security Decision Criticality

Functions that make high-impact security decisions rank above helper functions.

Higher priority:

- authentication
- signature verification
- certificate validation
- authorization
- permission checks
- state-machine gates
- boundary checks
- resource lifecycle decisions

Lower priority:

- logging
- formatting
- ordinary data movement
- generic helpers without security decisions

### 3. Suspicious Missing-Logic Signal

A subagent report that says:

- this module should have had a check here but it appears missing
- this module should have had a guard, validation, or state gate here but it does not

should rank above a signal that only says:

- there is a dangerous function call here

### 4. Cross-Module Inconsistency

If similar modules, code paths, or implementations treat the same security concern differently, rank that candidate higher.

### Ranking Intuition

Rank highest when the signal is:

- highly exposed
- highly security-critical
- shows a likely missing protection
- or reveals a cross-module inconsistency

Rank much lower when the signal is:

- weakly exposed
- only a helper function
- only a generic dangerous call with no stronger context
- not supported by any broader inconsistency or missing-logic observation

## Result File Rules

Only the main agent may write final merged candidates.

Completion rules for the main agent:

- do not write final merged candidates from scan subagents
- write `scan_candidates.json` only after global aggregation and prioritization is finished
- do not invent fake candidates when no candidate survives aggregation
- if no final candidate survives, still write `{"candidates":[]}`

## Recommended Output Artifacts

Recommended main-agent artifacts:

- `01_repository_layout.md`
- `02_module_plan.json`
- `02_module_plan.md`
- `02_shared_context.md`
- `03_codex_report.md`

Recommended per-module artifacts:

- `modules/<moduleName>/01_module_summary.md`
- `modules/<moduleName>/02_candidate_drafts.json`
- `modules/<moduleName>/02_candidate_drafts.md`

## Non-Goals

Do not:

- try to prove exploitability at the full-scan stage
- require CodeQL reachability proof before reporting a candidate
- require fuzzing before reporting a candidate
- allow subagents to write final merged candidates independently
- skip global deduplication and prioritization
- flood the system with repeated low-value candidates from adjacent helper functions

## Completion Condition

Stop only when:

1. repository structure was modeled
2. modules were partitioned
3. each module was screened
4. module outputs were aggregated
5. final candidates were globally deduplicated and prioritized
6. the final report was written
7. final `scan_candidates.json` was written
