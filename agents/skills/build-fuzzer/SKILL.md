---
name: build-fuzzer
description: Build a per-candidate LibAFL fuzzing program from an analysis-provided harness request, using LibAFL patterns and sanitizer instrumentation.
---

# Build Fuzzer

Build a per-candidate LibAFL fuzzing program from an analysis-provided harness request.

Use the installed `libafl` skill for fuzzer construction patterns and the
installed `address-sanitizer` skill for memory-safety instrumentation choices.

## Workflow

1. Read the build request, candidate context, entry-to-candidate path, harness requirements, and expected trigger condition.
2. Create a Rust crate under the task directory. Keep all generated source files, build logs, and artifacts under the task directory.
3. Implement a harness that drives the requested entry path toward the candidate site. Prefer a small deterministic harness over broad scaffolding.
4. Enable sanitizers and debug symbols when they fit the target language and build system.
5. Build the executable fuzzer. Capture stdout/stderr into log files under the task directory.
6. Return the structured result and route requested by the stage prompt.

## Fuzz Goal

Support both build-request goals:

- `evidence`: build a harness to validate or disprove the concrete hypothesis
  and expected trigger condition
- `exploration`: build a harness to explore complex control flow, parser
  boundaries, state machines, protocol interactions, input classes, and
  unexpected states

Use `harnessEntry`, `inputModel`, `expectedOracle`, `seedCorpusHints`,
`buildCommandHints`, and `sanitizerRuntimeAssumptions` as the executable test
specification.

The structured result should include the build status, build logs or error
summary, executable path when available, `fuzzGoal`, `harnessEntry`,
`inputModel`, `expectedOracle`, `seedCorpusPath`, notes, and artifact paths.

## Build Decision

Choose the success path only when the executable was built and can be run.
Choose the analysis-feedback path when the build failed, the request is not
actionable, or the harness would not exercise the requested path.
