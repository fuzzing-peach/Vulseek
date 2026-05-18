---
name: libafl-fuzz
description: Run a built LibAFL fuzzing program within a budget, collect corpus/crash/log artifacts, and report fuzzing evidence back to analysis.
---

Run a built LibAFL fuzzing program within the budget provided by the prompt.

Use the installed `coverage-analysis` skill when coverage data can clarify
whether the harness is exercising the requested path or blocked before the
candidate.

## Workflow

1. Inspect the build result and locate the executable.
2. Run the fuzzer within `fuzzing_budget_seconds`.
3. Store corpus, crashes, triggering inputs, stdout/stderr, and summary logs under the task directory.
4. Use coverage feedback when available to assess harness effectiveness and blockers.
5. Decide whether a triggering input was found.
6. Return the structured result and route requested by the stage prompt.

## Run Decision

Always send the result back to analysis, whether a triggering input was found or
not. The useful output is evidence: trigger path, corpus location, crash
artifacts, logs, coverage notes, and remaining blockers.
