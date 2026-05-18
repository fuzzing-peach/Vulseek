---
name: libafl-fuzz
description: Run a built LibAFL fuzzing program within a budget, collect corpus/crash/log artifacts, and report fuzzing evidence back to analysis.
---

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
5. Write fuzzing progress to `fuzz-progress.jsonl` in the task directory.
6. Use coverage feedback when available to assess harness effectiveness and blockers.
7. Decide whether a triggering input was found.
8. Return the structured result and route requested by the stage prompt.

## Progress Metrics

The task directory must contain `fuzz-progress.jsonl`. Each line should be a
JSON object emitted from a LibAFL monitor, not parsed from stdout. Use
`JSONLPrintingMonitor.rs` in this skill directory as the copyable reference
implementation.

The JSONL monitor records only data visible to LibAFL `Monitor::display`:
`eventMsg`, `senderId`, global runtime stats, corpus size, objective size,
executions, exec/sec, optional edge coverage, and `userStats`. Do not invent
top-level `crashCount` or `timeoutCount`; if those are needed, emit them as
LibAFL user stats so they appear under `userStats`.

## Run Decision

Always send the result back to analysis, whether a triggering input was found or
not. The useful output is evidence: trigger path, corpus location, crash
artifacts, logs, coverage notes, and remaining blockers.
