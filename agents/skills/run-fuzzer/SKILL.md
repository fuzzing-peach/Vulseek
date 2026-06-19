---
name: run-fuzzer
description: Run a built LibAFL fuzzing program within a budget, collect corpus/crash/log artifacts, and report fuzzing evidence back to analysis.
---

# Run Fuzzer

Run a built LibAFL fuzzing program within the budget provided by the prompt.

The fuzzing implementation must use LibAFL as the fuzzing framework. Use
LibAFL components such as `StdFuzzer`, `StdState`, an `Executor`, an
`EventManager`, and a `Monitor`. Do not treat a hand-written mutation loop, a
single replay, or a smoke test as the FuzzRunStage fuzzing implementation.

Use the installed `coverage-analysis` skill when coverage data can clarify
whether the harness is exercising the requested path or blocked before the
candidate.

## Workflow

1. Inspect the build result and locate the executable.
2. Confirm the executable is a real LibAFL fuzzer, not a custom loop or replay-only harness.
3. Run the fuzzer within `fuzzing_budget_seconds`.
4. Store corpus, crashes, triggering inputs, stdout/stderr, and summary logs under the task directory.
5. Write fuzzing progress to exactly `/task/fuzz-progress.jsonl`.
6. Use coverage feedback when available to assess harness effectiveness and blockers.
7. Decide whether a triggering input was found.
8. Return the structured result and route requested by the stage prompt.

Treat fuzzing as both evidence collection and path/state exploration.

For evidence-oriented fuzzing, report whether the expected trigger condition was
observed and what negative evidence was collected.

For exploration-oriented fuzzing, report newly reached paths or states, input
classes discovered, coverage or proximity observations, and any unexpected
behavior that should become a new analysis hypothesis.

Exploration fuzzing may run in `short` or `full` mode. A short run is a 90
second sprint used to decide whether the harness is discovering useful state.
If a short run finds the final triggering input, report it and route back to
analysis. If it does not find the trigger but makes exploration progress, set
`promotionDecision.shouldPromote` to true so the pipeline can start a full run
with the short result as context.

## Progress Metrics

The task directory must contain `/task/fuzz-progress.jsonl`. Each line must be
a JSON object emitted from a LibAFL monitor, not parsed from stdout and not
hand-written by the run agent as a substitute. Use `JSONLPrintingMonitor.rs` in
this skill directory as the copyable reference implementation.

The JSONL monitor records only data visible to LibAFL `Monitor::display`:
`eventMsg`, `senderId`, global runtime stats, corpus size, objective size,
executions, exec/sec, optional edge coverage, and `userStats`. Do not invent
top-level `crashCount` or `timeoutCount`; if those are needed, emit them as
LibAFL user stats so they appear under `userStats`.

Before returning, verify that `/task/fuzz-progress.jsonl` exists and contains
at least one valid JSONL monitor record. If the executable does not use
`JSONLPrintingMonitor`, treat the run as a failed/non-compliant fuzz run rather
than fabricating a progress file.

## Run Decision

Send full runs, non-promoted short runs, and short runs with a triggering input
back to analysis. For a short exploration run with no triggering input but clear
progress, route to `run_fuzzer` for promotion to a full run.

Use a Coverage/Corpus promotion strategy. Promote when the short run shows
corpus growth, objective growth, edge coverage growth, non-empty
`newPathsOrStatesReached`, non-empty `inputClassesDiscovered`, or coverage /
proximity observations showing movement toward the requested target path.
Do not promote when the short run already found the final triggering input.

Populate structured fields such as `commandRun`, `exitStatus`, `crashSignal`,
`observedBehavior`, `negativeEvidence`, `coverageProximity`,
`newPathsOrStatesReached`, `inputClassesDiscovered`, `confidenceImpact`, and
artifact paths when available. Always populate `promotionDecision` with
`shouldPromote`, concrete `reasons`, and relevant `metrics` such as corpus size,
objective size, edge coverage, execution count, or proximity notes.
