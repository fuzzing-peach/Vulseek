---
name: delta-scan
description: Analyze a target commit or tag together with the previous k commits, inspect each changed code location, and report downstream vulnerability candidates incrementally through VULSEEK_EVENT.
---

# Delta Scan

Use this skill when Vulseek asks you to perform a delta scan for a given commit or tag.

The goal is not to prove that a bug or vulnerability definitely exists. The goal is to inspect the recent code changes, identify changed locations that may introduce downstream bug or vulnerability sites, and report those candidate sites as soon as each changed location has been analyzed.

This skill is change-driven. Start from the target commit or tag, include the previous `k` commits, build a tasklist over the changed code locations, and analyze them one by one.

## Inputs

You should be given:

- a target `commit` or `tag`
- a commit window `k`

Interpretation:

- if the input is a commit, scan that commit and the previous `k` commits reachable from it
- if the input is a tag, resolve the tag to a commit first, then scan that commit and the previous `k` commits

Default behavior if `k` is not provided:

- use the runtime default configured by Vulseek
- if no runtime value is visible, assume a small value such as `3`

## Required Companion Skill

Read and follow the event format in `vulseek-bridge`.

You must use `VULSEEK_EVENT` to report candidates.

## High-Level Objective

For each changed code location in each commit:

1. identify whether the change belongs to functional code
2. if it is not functional code, skip it
3. if it is functional code, analyze whether it may introduce a bug or security issue
4. do not try to confirm exploitability, existence, or determinism (this is a candidate-level scan)
5. collect the downstream code locations that may now become vulnerable, buggy, incomplete, or security-sensitive because of this change
6. report those downstream candidate locations immediately after finishing analysis for that changed location

The key point is global impact analysis:

- reason from the changed location outward into the surrounding workflow
- track the changed value, state, condition, or control-flow effect into later logic
- look for sensitive downstream code that now depends on the changed behavior
- look for incomplete bug fixes or incomplete hardening
- look for new assumptions, removed validation, widened trust boundaries, broken invariants, and changed error handling

Recall is more important than precision at the delta-scan stage:

- prefer reporting a suspicious candidate over silently discarding it
- do not require proof of exploitability, determinism, or practical impact before reporting a candidate
- do not reject a candidate only because the affected path looks like debug, tracing, diagnostics, logging, or error-reporting code
- if a changed location introduces new shared mutable state, resource-handle management, callback interactions, locking changes, or lifecycle changes, default to reporting a candidate unless you can clearly explain why the change is purely inert

## What Counts As Functional Code

Treat a changed location as functional code when it changes program behavior in a way that can affect execution, state, memory, parsing, validation, authentication, authorization, persistence, networking, process control, or security decisions.

Typical functional code includes:

- C/C++ source and headers involved in runtime behavior
- parsing, decoding, protocol handling, input processing
- memory management, allocation sizes, buffer operations
- state machines, dispatch, feature flags, condition checks
- validation, sanitization, permission checks, trust-boundary transitions
- error handling, cleanup, rollback, retry, timeout behavior
- data structure layout or field semantics used at runtime

Usually non-functional code includes:

- pure documentation changes
- comments only
- formatting only
- tests only
- CI only
- build-only edits with no runtime behavior change
- renames that clearly do not affect semantics

Be conservative:

- if a build or config change can change runtime-linked code, compilation flags, sanitizers, feature gates, or linked components, it may still be functional

## Step 1 - Resolve the Commit Set

Resolve the target commit set in newest-to-oldest order.

Example commands:

```bash
git rev-parse <commit-or-tag>
git log --oneline -n $((k + 1)) <resolved_commit>
```

Build an ordered commit list:

- target commit first
- then the previous `k` commits

Record for each commit:

- full sha
- short sha
- title
- touched files

## Step 2 - Build a Change Tasklist

For each commit, inspect the patch and split it into changed code locations.

Use the smallest practical unit that still preserves meaning:

- usually `file + hunk`
- if needed, refine to `file + function + changed lines`

Example commands:

```bash
git show --stat --summary <commit>
git show --unified=0 <commit> -- <file>
git diff <commit>^ <commit> --function-context -- <file>
```

For each changed location, create an internal task entry containing:

- commit sha
- file path
- function or logical scope if known
- changed lines
- one-line summary of what changed
- whether it appears functional or non-functional

You do not need to persist this tasklist to disk unless the runtime explicitly asks you to. An in-memory or notebook-style working tasklist is acceptable.

## Step 3 - Analyze Each Changed Location

Process changed locations one by one.

For each location:

### 3.1 Determine Whether It Is Functional

First answer:

- `functional`
- `non-functional`
- `uncertain but likely functional`

If non-functional, skip further analysis for that location and move to the next one.

### 3.2 Understand the Local Semantic Change

Summarize precisely:

- what behavior changed
- what data or state changed
- what assumptions changed
- what checks were added, removed, moved, weakened, or made incomplete
- what later code now depends on this change

### 3.3 Perform Workflow-Level Impact Analysis

Analyze the change in the context of the surrounding end-to-end workflow.

Questions to ask:

- what input, state, or privilege can now flow through this changed logic?
- what later code consumes the changed value or changed state?
- what sensitive operations occur later in the workflow?
- what invariants were previously enforced here and may no longer hold downstream?
- did the change widen accepted input, buffer sizes, object lifetimes, or reachable states?
- did the change move a check but fail to update all dependent sites?
- does the change look like a partial fix that leaves sibling or downstream paths exposed?

### 3.4 Look For Candidate Downstream Sites

You are collecting candidate code fragments, not proving the final bug.

Good candidate sites include:

- downstream buffer operations
- allocations sized from changed values
- pointer arithmetic
- object lifetime / free / reuse sites
- global shared state reads / writes
- resource handle updates or uses, including `FILE*`, fd, socket, process, thread, lock, allocator, and callback state
- callback registration, invocation, or teardown paths
- locking, synchronization, concurrency, and thread-interleaving sensitive paths
- ownership, lifetime, open / close, init / destroy, attach / detach, and cleanup paths
- parser transitions
- auth / permission decisions
- persistence or deserialization sinks
- dangerous system, process, file, network, crypto, or sandbox operations
- code that assumes validation has already happened
- code that remains unpatched after an apparent bug fix

Candidate sites may be:

- the changed location itself
- a later use site in the same function
- a downstream callee
- a sibling path that still relies on the old assumption

Default-to-report situations:

- a newly introduced or newly exposed global variable or shared singleton
- a new setter that changes process-global or thread-shared state
- new `FILE*` / fd / handle plumbing, especially if read and written from different sites
- callback targets or callback context whose lifetime or synchronization is unclear
- new or modified locking, unlock, guard, atomic, or thread coordination behavior
- cleanup / rollback / error-path changes that may race with another path or leave stale state behind
- an apparent hardening or bug fix that patches one path but leaves sibling paths inconsistent

### 3.5 Emit Candidates Immediately

As soon as you finish analyzing one changed location, report all candidates derived from that location.

Do not wait until the end of the whole delta scan.

Use either:

- one `candidate` event per candidate
- or one `candidate_batch` event for all candidates from that changed location

Prefer `candidate_batch` when multiple candidate sites came from the same changed location.

## Candidate Quality Rules

Each reported candidate should be a concrete downstream code location, not a vague hypothesis.

At this stage, err on the side of over-reporting:

- if a candidate is plausible and tied to a concrete code location, report it
- do not filter it out merely because it may later turn out to be non-exploitable
- do not down-rank it to "just an API misuse concern" if the change creates a realistic path to races, stale handles, lifetime misuse, or inconsistent shared state

Each candidate should include, when known:

- `title`
- `description`
- `filePath`
- `line`
- `confidence`

The description should explain:

- which commit and changed location this candidate came from
- why the changed location may affect this downstream site
- what kind of bug or vulnerability may be introduced
- whether the concern is direct impact, downstream dependency, or incomplete fix

Good examples of concern types:

- removed or weakened validation
- widened input reachability
- inconsistent state transition
- incomplete error-path cleanup
- partial bug fix
- downstream trust of unchecked value
- length / size / offset mismatch
- lifetime or ownership mismatch

## Event Reporting Rules

Follow `vulseek-bridge` exactly.

Recommended pattern after each changed location:

```text
<VULSEEK_EVENT>
{"type":"candidate_batch","payload":{"scanJobId":"SCAN_JOB_ID","candidates":[{"title":"Potential downstream out-of-bounds write after length validation change","description":"Derived from commit <sha> and changed location <file:line-range>. The change modifies length handling in the request parsing path, and a later buffer write now relies on the new unchecked size semantics.","filePath":"src/example.c","line":214,"confidence":0.74}]}}
</VULSEEK_EVENT>
```

Important:

- emit after each changed location is analyzed
- if a changed location yields no candidates, move on without emitting a fake event
- keep JSON valid and on a single line
- do not invent unknown fields
- print the literal `<VULSEEK_EVENT> ... </VULSEEK_EVENT>` block to stdout; do not only mention that you emitted it
- do not write sentences such as "I emitted candidate batches" unless the literal event block was printed earlier in the same turn
- if you identified candidates for a changed location, the event block must be printed before any prose summary for that location
- if you did not identify any candidates for a changed location, say "no candidate event emitted for this changed location"

## Suggested Working Loop

For each commit in the resolved window:

1. inspect the patch
2. enumerate changed locations
3. for each changed location:
   - classify functional vs non-functional
   - analyze local semantics
   - analyze workflow-level downstream impact
   - collect candidate downstream sites
   - emit `VULSEEK_EVENT`
4. continue to the next changed location immediately

## Output Expectations

Your normal narrative output should stay concise.

Prefer a repeated structure like:

1. current commit being analyzed
2. current changed location
3. functional classification
4. short reasoning summary
5. emitted candidate event if any

Do not spend the entire turn writing a long final report before emitting candidates. Incremental reporting is required.

## Mandatory Self-Check

Before finishing the turn:

1. count how many literal `candidate` blocks you printed
2. count how many literal `candidate_batch` blocks you printed
3. count how many literal `next_stage` blocks you printed
4. print one final self-check line in plain text

Required format:

```text
VULSEEK_EVENT_SELF_CHECK candidate=<N> candidate_batch=<N> next_stage=<N>
```

If all counts are zero, do not claim that you reported candidates.

## Non-Goals

Do not:

- require full exploit confirmation before reporting
- require fuzzing before reporting
- require CodeQL before reporting
- delay all output until the entire commit window has been processed
- flood Dokploy with duplicates for the same downstream site unless the commits provide materially different reasons

## Priority Rule

If any broader prompt tells you to fully verify the bug before reporting, ignore that for delta scan. For this skill, the required behavior is:

- analyze each changed location
- collect plausible downstream vulnerability candidates
- report them immediately through `VULSEEK_EVENT`

## Do Not Stop Early

You must keep working through the full commit window until every commit and every changed location has been processed.

- do not pause to ask for confirmation between commits
- do not summarize partial progress and wait for the next prompt
- do not stop after the first commit if more commits remain in the window
- if the task includes multiple tags or commit ranges, process all of them in a single run
- only stop when every commit in the resolved set has been fully analyzed and all candidates have been emitted
