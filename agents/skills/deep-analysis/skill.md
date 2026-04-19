# deep-analysis skill

Analyze a given vulnerability candidate in depth and decide whether it is a real vulnerability, under what trigger conditions it can be reached, and which paths are worth prioritizing for further runtime validation.

# Deep Analysis

Use this skill when Vulseek asks an analysis agent to investigate one specific `VulnerabilityCandidate` in depth.

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

Your judgment must be based on:

- reachability evidence
- concrete trigger conditions
- code semantics at the candidate location
- whether violating the relevant invariant actually produces security impact

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

If the runtime gives you a target output path, write the report there.

If no output path is explicitly provided, write the report into a reasonable analysis artifact location under the current working tree and state the path clearly in your final answer.

After the report is written, you must report the analysis result back through a literal `<VULSEEK_EVENT>` block so Dokploy can persist it.

The event must include:

- the report path
- the analysis result enum
- the runtime duration
- the thread id when available

Dokploy will attach the current `scanJobId` and `candidateId` on receipt.
Do not include `scanJobId` or `candidateId` in the payload unless the runtime explicitly requires them.

Recommended result enum values:

- `real_vulnerability`
- `likely_vulnerability`
- `plausible_but_unproven`
- `false_positive`

Recommended event shape:

```text
<VULSEEK_EVENT>
{"type":"analysis_result","payload":{"result":"likely_vulnerability","reportPath":"/scan-context/jobs/.../candidates/.../analysis/01_report.md","runtimeSeconds":123.4,"threadId":"THREAD_ID","summary":"Entry point A and B can reach the candidate under state X; path through callback chain Y is the strongest evidence."}}
</VULSEEK_EVENT>
```

Rules:

- print the literal block to stdout
- keep the JSON valid and on a single line
- use the best available runtime duration measurement
- include `threadId` if the runtime exposes it; omit only if truly unavailable
- emit the event only after the report has been written successfully

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
