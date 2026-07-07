---
name: full-scan-subagent
description: Screen one repository module for security-sensitive candidate locations during a full scan. Use when a main full-scan agent has already partitioned the repository, provided module boundaries and minimal shared context, and needs a module-level candidate draft report rather than final merged candidate output.
---

# Full Scan Subagent

Use this skill when you are the scan subagent for one repository module inside a full-scan job.

You do not own repository-wide orchestration.
You do not own final merged candidate output.
You do not need to prove that a vulnerability exists.

Your job is to screen one assigned module and return candidate drafts to the main agent.

## Non-Goals

Do not:

- write final merged candidate JSON
- do deep exploit confirmation
- require CodeQL reachability proof
- require fuzzing
- try to fully verify a vulnerability
- rewrite the module plan created by the main agent

## Inputs

You should be given:

- the assigned module boundary
- the module file list
- the minimal shared context from the main agent
- the current checked-out repository
- an output path or a clear place to write the module report

Useful shared context may include:

- repository-level summary
- build-system boundaries
- core runtime directories
- skipped or down-ranked directories
- likely attack-surface categories
- major public APIs, entry points, and shared infrastructure

## Tooling

Preferred tools:

- `rg`
- `find`
- `sed`
- `awk`

Optional tool:

- `semgrep` for lightweight auxiliary search only

Tooling rules:

- prefer `rg` for fast code search and symbol-like text search
- use `find` to enumerate module files or narrow file scope
- use `sed` and `awk` for quick local extraction and summarization
- use `semgrep` only as a lightweight helper when plain text search is not enough
- do not turn this stage into a heavy rule-scan job
- do not use CodeQL, fuzzing, or long-running build-heavy workflows here

## High-Level Objective

For your module:

1. understand what the module does
2. identify which functions or patterns are security-sensitive
3. identify missing or inconsistent security logic at the module level
4. return a candidate draft set to the main agent

A candidate draft means:

- a location or pattern that is security-relevant enough for later deep analysis
- not a proven vulnerability
- not yet a final merged candidate record

## Phase 1 - Understand Module Responsibility

Quickly read enough code to establish a rough module model.

Determine:

- what role this module plays in the project
- what functionality it implements
- what externally visible interfaces it exposes
- whether it is close to external inputs, security decisions, state transitions, resource handling, or shared infrastructure

Write a short summary:

- one or two sentences describing the module's responsibility
- a short list of important module entry points or externally visible interfaces

Do not spend too much time here.
This is only context for better screening.

## Phase 2 - Function-by-Function Screening

Traverse the module's functions and do a fast security-sensitivity pass.

For each function, ask:

- does it receive or process externally controllable input?
- does it participate in authentication, authorization, signature verification, certificate handling, permissions, policy checks, or trust-boundary transitions?
- does it perform parsing, decoding, state-machine transitions, validation, boundary checks, length checks, or integer checks?
- does it allocate, free, reuse, transfer, or otherwise manage memory or resource lifetime?
- does it manage files, sockets, IPC, callbacks, threads, locks, `FILE*`, allocators, or other shared resources?
- does it make a security-relevant decision?
- does it call a potentially dangerous operation?

If the function is clearly security-sensitive, record a candidate draft.

If the function is clearly not security-relevant, skip it.

Make this a fast judgment based on:

- function signature
- key lines
- nearby checks
- obvious callers or callees
- obvious data/control role in the module

Do not fully reverse-engineer every function.

## Phase 3 - Module-Level Observations

After function-level screening, step back and inspect the module as a whole.

Look for signals that are easy to miss from a single-function view.

Focus especially on:

1. missing security logic that should exist given the module's responsibility
2. inconsistent security handling across similar functions in the same module

Examples:

- one parser path validates a size, a sibling path does not
- one API path enforces a permission or state precondition, another equivalent path does not
- the module clearly handles untrusted input, but a validation or gate that should exist appears absent
- similar resource lifecycle paths clean up differently
- similar callback or lock handling paths have inconsistent guards

These module-level signals should also be returned as candidate drafts.

## What To Mark

Good candidate draft targets include:

- externally exposed entry-handling functions
- security-critical decision points
- validation and boundary-check code
- dangerous sinks worth later deep analysis
- missing validation or missing guards implied by module responsibility
- inconsistent handling across similar functions
- lifecycle, cleanup, callback, locking, and shared-state sensitive code

Lower-priority but still sometimes relevant targets include:

- helper functions near a security-critical path
- wrappers around dangerous operations
- translation or conversion points that affect later security checks

Purely cosmetic helpers, inert logging, and clearly non-runtime code should usually be skipped.

## Candidate Draft Fields

For each candidate draft, include when known:

- `title`
- `description`
- `filePath`
- `line`
- `confidence`
- `sensitivityType`
- `reasonCategory`

Good `reasonCategory` examples:

- `external_input`
- `security_decision`
- `dangerous_sink`
- `validation_logic`
- `boundary_check`
- `resource_lifecycle`
- `shared_state`
- `callback_or_concurrency`
- `missing_security_logic`
- `inconsistent_security_handling`

Keep the description short and structural.
Put the longer reasoning in the module report.

## Output Contract To The Main Agent

You are returning results to the main agent, not to Vulseek directly.

Your output should contain:

1. module responsibility summary
2. main module entry points or externally visible interfaces
3. candidate draft list
4. optional notes on unclear areas or weak signals

Recommended artifact files:

- `01_module_summary.md`
- `02_candidate_drafts.json`
- `02_candidate_drafts.md`

If the runtime gives you exact output paths, use them.
If not, write them under a reasonable module-specific artifact directory and clearly state the paths.

### Fixed JSON Schema

`02_candidate_drafts.json` should use this fixed structure:

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

Rules:

- keep the JSON valid
- use one top-level object only
- `module.name` and `module.summary` should always be present
- `module.entryPoints` should be an array; use `[]` if none were identified
- `candidates` should be an array; use `[]` if no candidate draft was found
- `notes` should be an array; use `[]` if there are no notes
- each candidate should stay focused on one concrete location or one concrete missing/inconsistent pattern
- do not invent extra top-level fields unless the runtime explicitly asks for them

## Quality Standard

Prefer concrete, reviewable candidate drafts over vague speculation.

Good:

- a function with a clear security role
- a missing check implied by the module's purpose
- an inconsistency across sibling functions
- a suspicious lifecycle or shared-state handling point

Weak:

- broad statements like "this module looks risky"
- generic dangerous-function hits with no module context
- duplicated drafts for adjacent helper functions that represent the same concern

## Completion Condition

Stop only when:

1. you wrote the module responsibility summary
2. you completed a function-level screening pass over the assigned module
3. you completed a module-level observation pass
4. you produced a candidate draft list for the main agent
5. you did not write final merged candidate output
