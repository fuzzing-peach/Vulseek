---
name: analyze
description: Analyze a vulnerability candidate in depth, establish reachability and constraints, decide whether fuzzing or critic review is needed, and prepare final analysis for verification.
---

Analyze a given vulnerability candidate in depth and decide whether it is a real vulnerability, under what trigger conditions it can be reached, and which paths are worth prioritizing for further runtime validation.

# Analyze

Use this skill when Vulseek asks an analysis agent to investigate one specific `VulnerabilityCandidate` in depth.

## Coordinator Decision Loop

In the analysis-fuzzing-debate workflow, this skill is a coordinator. The
analysis agent decides which result type the current turn needs. The stage
prompt defines the exact schema and route markers for each decision.

Allowed decisions:

- Need fuzzing evidence or dynamic exploration: request fuzzer construction.
- Current draft analysis appears established: submit a draft analysis to the critic.
- The latest critic response is `convinced` for the same analysis fingerprint: finalize the analysis for verification.

Do not route `verification` directly from your own judgment. A matching convinced
critic response is required first. If the critic objects, or if your own view
changes, continue the build/fuzz/critic loop.

## Analysis Result Content

When your current decision is to submit a draft analysis to the critic or to
return a final critic-approved analysis, include the classification, score,
summary, confidence when supported, report path, and runtime status requested by
the stage prompt.

Also keep the structured analysis object evidence-oriented. Populate:

- `hypothesis`: the current vulnerability claim or false-positive hypothesis
- `evidenceTable`: code, negative, runtime, fuzz, and critic evidence collected
  so far
- `attackPath`: entry-to-candidate path, source-to-sink path, and control-flow
  constraints
- `blockers`: missing data, failed tooling, unknown preconditions, or blocked
  dynamic exploration
- `rulingRationale`: why the current result follows from the evidence
- `missingEvidenceRequest`: what would most efficiently change confidence
- `feedbackHistory`: relevant fuzz-build, fuzz-run, critic, and manual feedback

For final critic-approved analysis, include the critic approval, the analysis
fingerprint, the evidence bundle, any fuzz evidence, verified attack path
details available so far, reproduction hints, and residual uncertainty.

Recommended result enum values:

- `real_vulnerability`
- `likely_vulnerability`
- `plausible_but_unproven`
- `false_positive`

The `score` is an estimated prioritization score on a 0-10 scale. It should combine:

- CVSS-style dimensions such as attack vector, attack complexity, privileges required, user interaction, scope, and confidentiality/integrity/availability impact
- usage breadth, meaning whether the affected path belongs to common/default/realistic deployment and call patterns or only rare edge-case usage

The score is an estimated prioritization score, not a precise CVSS base score. Keep it internally consistent and explain the rationale in the markdown report.

Do not write a separate machine-readable result file unless the stage prompt
explicitly requires it.

The goal is not to restate why the candidate was reported. The goal is to determine whether the candidate corresponds to a real vulnerability, what reachable execution paths lead to it, what untrusted inputs can influence it, and what concrete trigger conditions must hold along those paths.

This skill is candidate-driven. Start from the given candidate location, recover the surrounding scenario and workflow, identify possible attack surfaces and entry points, trace reachability toward the candidate, collect control-flow constraints, and finally judge whether the candidate is a true vulnerability or should be rejected.

## Inputs

You should be given:

- the candidate itself
- the candidate file path and line when available
- the candidate title and description
- the current checked-out source tree
- any existing analysis artifacts already produced for the same scan job

Optional helpful inputs:

- previous candidate reports
- repository state summary
- codeql database path
- semgrep rules or semgrep skill path
- fuzzing-related code, harnesses, corpora, or build scripts

## Fuzzing Decision

Actively consider fuzzing. Fuzzing is useful for two reasons:

- evidence: validate or disprove a concrete hypothesis and expected trigger
  condition
- exploration: explore complex control flow, parser boundaries, state machines,
  protocol interaction, input classes, unexpected states, or hard-to-enumerate
  preconditions

Do not reserve fuzzing only for strong vulnerability claims. If static analysis
cannot reliably cover a path or state space, request a fuzzer even when the
current goal is path discovery or negative evidence.

When requesting a fuzzer, populate the build request with:

- `candidateId`
- `analysisFingerprint`
- `fuzzGoal` as `evidence` or `exploration`
- `entryToCandidatePath`
- `harnessRequirements`
- `harnessEntry`
- `inputModel`
- `expectedOracle`
- `seedCorpusHints`
- `buildCommandHints`
- `sanitizerRuntimeAssumptions`
- `expectedTriggerCondition`
- `targetFunction`
- `targetFilePath`
- `notes`

## High-Level Objective

For the given candidate:

1. determine the concrete runtime scenario in which this candidate exists
2. identify all plausible untrusted-input entry points that may reach this scenario
3. determine whether the entry points can actually reach the candidate through data flow and control flow
4. collect the control-flow constraints and environmental assumptions that must hold along each reachable path
5. prioritize deeper, loop-heavy, stateful, and fuzzing-hard paths
6. decide whether the candidate corresponds to a real vulnerability, a likely vulnerability, a weak hypothesis, or a false positive

The key point is path-grounded judgment:

- do not stop at local code inspection
- reason from program entry to candidate
- recover the surrounding workflow, state machine, and call chain
- track both data dependencies and control dependencies
- identify exact constraints that gate execution
- prefer concrete reachable paths over abstract speculation

## Analysis Standard

At this stage, rigor matters more than recall.

- you must try to prove or disprove reachability
- you must identify trigger conditions explicitly
- you should distinguish between:
  - locally suspicious but unreachable
  - reachable but low-impact
  - reachable and realistically vulnerable
  - reachable only under extreme or invalid assumptions
- if evidence is incomplete, say exactly what is missing

## API Misuse Decision Framework

When deciding whether a candidate is a product vulnerability or merely API misuse, use a strict standard.

Do not classify something as API misuse unless the burden clearly belongs to the caller.

You must evaluate all of the following dimensions:

### 1. Documented Contract

Check whether the relevant usage constraint is explicitly documented in a place the caller can reasonably discover.

Acceptable sources include:

- API documentation
- header comments
- parameter comments
- usage manuals
- standards or protocol specifications implemented by the API

Treat as possible misuse only if the precondition is clearly stated, such as:

- input must already be validated
- IV or nonce reuse is forbidden
- this function is only for trusted input
- caller must initialize or configure some object first

If the constraint is undocumented, ambiguous, buried, or only inferable from implementation details, do not classify it as API misuse.

### 2. Security Responsibility Boundary

Decide which side is responsible for the security property at issue.

Core rule:

- if a function claims to perform a security decision, validation, verification, authorization, signature check, certificate check, or similar security-sensitive task, then correctness and completeness of that task are the function's responsibility
- if a function is a low-level primitive with no security semantics of its own, then supplying sane inputs may be the caller's responsibility

Bias:

- the higher-level and more security-semantic the API is, the harder it is to dismiss defects as misuse
- the lower-level and more mechanical the API is, the more plausible misuse becomes

### 3. Caller Capability And Reasonable Obligation

Ask whether the caller could realistically know and enforce the missing check.

Do not classify as misuse if avoiding the issue requires:

- implementation-specific hidden knowledge
- cryptographic or protocol subtleties beyond what the API exposes
- reverse-engineering internal invariants
- knowledge that ordinary callers should not be expected to have

Misuse is more plausible only when:

- the caller-facing rule is simple
- the rule is documented
- the caller can realistically enforce it before calling the API

### 4. Misuse Prevalence Signal

Check whether multiple independent call sites use the API in the same problematic way.

If several independent callers make the same mistake, treat that as a strong signal that:

- the API design is misleading
- the default behavior is unsafe
- the documentation is inadequate
- the burden should not be placed entirely on the caller

In such cases, even if misuse is technically arguable, you should lean toward identifying an API design or library hardening problem rather than excusing it as caller misuse.

## Default Bias

If the evidence is mixed, prefer:

- `real vulnerability`
- `likely vulnerability`
- or `plausible but unproven`

over `api misuse`.

Do not use `api misuse` as the default explanation for public API reachable security-impacting behavior.

## Step 1 - Reconstruct the Candidate Scenario

First determine what this candidate actually is in program context.

For the candidate location:

- identify the function
- identify the caller-visible scenario
- identify what program component this belongs to
- identify what high-level step of the program this code runs in

Questions to answer:

- is this code in parsing, decoding, request handling, state transition, callback dispatch, cleanup, teardown, logging, crypto, filesystem, IPC, or another subsystem?
- does it run during initialization, steady-state handling, error handling, shutdown, or background processing?
- is it directly invoked by an exposed API, indirectly reached through internal flows, or only reached through rare auxiliary paths?

Write down:

- the component / subsystem
- the surrounding workflow step
- the local function purpose
- the candidate operation that may be vulnerable

## Step 2 - Collect Attack Surfaces and Entry Points

Determine where untrusted input can enter the relevant workflow.

Untrusted inputs may include:

- network input
- file input
- IPC input
- environment variables
- command-line arguments
- configuration files
- shared memory or externally supplied buffers
- public library APIs callable by external applications

You may use:

- `semgrep`
- custom semgrep rules
- `grep`, `rg`, or similar text searches
- local call-chain inspection

Useful tasks:

- search for public API entry points
- search for parser entry functions
- search for file-loading functions
- search for socket read / recv / accept handlers
- search for callback registration and invocation
- search for fuzz targets, harnesses, corpora, and fuzzing configs

Lookup priority for this entire analysis:

1. prefer Serena for symbol lookup, function lookup, caller/callee navigation, and related code discovery
2. use `semgrep` for structural search patterns when Serena is not enough
3. use `rg`, `grep`, or similar text tools as fallback

For this step, collect:

- all plausible entry points relevant to the candidate
- whether the repository already contains fuzzing code for this area
- whether the candidate itself or its surrounding path is already covered by fuzz-related infrastructure

If you write semgrep rules, keep them in a temporary analysis directory and use them to accelerate entry-point discovery.

## Step 3 - Trace Reachability from Entry to Candidate

Determine whether the candidate is actually reachable from the collected entry points.

Prefer CodeQL when available.

Tasks:

- run data-flow analysis from entry to candidate
- run control-flow analysis for gating branches and state transitions
- identify intermediate functions, callbacks, state-machine steps, and loop bodies
- identify whether the candidate depends on transformed, validated, or partially constrained input

If CodeQL is available:

- use an existing database if valid
- rebuild the CodeQL database if needed
- write targeted queries when stock query packs are insufficient

If CodeQL is unavailable or broken:

- perform manual path tracing with `grep`, `rg`, call-chain inspection, and source reading
- continue tracing step by step instead of giving up
- when doing manual path tracing, still prefer Serena first for symbol-aware navigation before falling back to raw grep

For each candidate path, collect:

- entry point
- call chain
- candidate sink location
- relevant data dependencies
- relevant control dependencies
- loop nesting and repeated-state behavior

## Step 4 - Collect Control-Flow Constraints

For each reachable or plausibly reachable path, identify the conditions that must hold.

Examples:

- feature flags
- compile-time guards
- runtime configuration checks
- protocol state requirements
- authentication state
- object lifecycle state
- buffer length relationships
- loop counters or iteration thresholds
- callback registration conditions
- lock ownership or thread interleavings
- error-path prerequisites

Do not just say "path is constrained".

Instead, explicitly state:

- which branch conditions must be true
- which values or states must already exist
- which checks may block the path
- which assumptions may invalidate the path

## Step 5 - Prioritize Deep and Fuzzing-Hard Paths

Among the reachable paths, prioritize the ones most valuable for vulnerability confirmation.

Prefer paths that are:

- deeper in the call chain
- behind multiple gates
- stateful
- loop-heavy
- callback-mediated
- concurrency-sensitive
- error-path dependent
- difficult for normal fuzzing to reach

For each prioritized path, explain why it matters.

This prioritization should help later debugging, harness construction, and fuzzing.

## Step 6 - Judge the Candidate

Finally decide whether the candidate is a real vulnerability.

Use one of these conclusions:

- `real vulnerability`
- `likely vulnerability`
- `plausible but unproven`
- `false positive`

Before finalizing the conclusion, explicitly decide whether the issue is:

- a product-side vulnerability
- a product-side hardening gap
- or true API misuse by the caller

If you believe it is misuse, justify that belief using all four dimensions from the API Misuse Decision Framework above.

Your judgment must be based on:

- reachability evidence
- concrete trigger conditions
- code semantics at the candidate location
- whether violating the relevant invariant actually produces security impact
- documented API contract quality
- responsibility boundary between API and caller
- whether callers can realistically be expected to perform the missing checks
- whether multiple call sites exhibit the same problematic pattern

When judging, answer:

- what exactly goes wrong?
- what input and state are needed?
- can the candidate be reached from a real attack surface?
- what security property is violated?
- what blocks exploitation, if anything?

If you reject the candidate, explain whether rejection is due to:

- lack of reachability
- impossible constraints
- non-security-only behavior
- defensive checks that fully block the issue
- incorrect original hypothesis
- or true API misuse with a clearly documented and reasonable caller obligation

## Output Requirements

Your final analysis should include:

- candidate summary
- scenario and subsystem
- collected attack surfaces / entry points
- fuzzing-related artifacts found in the repository, if any
- reachable paths
- control-flow constraints
- prioritized paths
- final vulnerability judgment

When possible, include:

- concrete file paths
- function names
- line numbers
- specific branch conditions
- specific API names

After finishing the analysis, you must write a Markdown report to disk.

The report should contain at least:

- candidate identity
- analyzed scenario
- attack surfaces and entry points
- fuzzing-related code or configuration found
- reachable paths
- control-flow constraints
- prioritized hard-to-reach paths
- final vulnerability judgment
- evidence and remaining uncertainty

You must strictly follow the fixed markdown template in `analysis-report-template.md`.

Do not invent your own section structure.
Do not rename the headings.
Do not omit a heading.
If a section is unknown, write `Unknown`, `None`, or `Not observed` explicitly instead of deleting the section.

If the runtime gives you a target output path, write the report there.

If no output path is explicitly provided, write the report under the current task artifact directory and state the path clearly in your final answer.

Persist the final classification only through the structured runtime return requested by the prompt.

Do not write extra machine-readable result files for this stage.

## Recommended Working Style

Recommended order:

1. read the candidate location and surrounding function
2. identify subsystem and runtime scenario
3. enumerate entry points
4. search for fuzzing artifacts in this area
5. run CodeQL or manual path tracing
6. record reachable paths and constraints
7. prioritize the most meaningful paths
8. issue the final judgment

## Practical Notes

- if CodeQL needs a rebuild, do it
- if CodeQL fails, fall back to manual path tracing immediately
- do not confuse public library APIs with internal helper functions
- do not assume a debug-only path is unreachable; prove or disprove it
- distinguish attack surface from intermediate internal call sites
- if multiple entries reach the same candidate, keep them all
- if the repository already has a fuzz target near the candidate, note whether it likely covers the critical path or misses the hard-to-reach path

## Decision Standard

The final question is:

- does this candidate correspond to a real vulnerability under a concrete reachable path?

If yes:

- state the path
- state the trigger conditions
- state the vulnerability type

If no:

- state exactly why not

If uncertain:

- state what evidence is still missing
- state which path or condition should be validated next
