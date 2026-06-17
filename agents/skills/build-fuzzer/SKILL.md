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
3. Implement a complete LibAFL fuzzer that drives the requested entry path toward the candidate site. Prefer a small deterministic harness over broad scaffolding, but it must still use LibAFL `StdFuzzer`, `StdState`, an `Executor`, an `EventManager`, and a `Monitor`.
4. Copy or inline `/workspace/repo/.agents/skills/run-fuzzer/JSONLPrintingMonitor.rs` into the generated crate and wire it into the LibAFL event manager.
5. Configure the generated fuzzer so LibAFL monitor events are appended to exactly `/task/fuzz-progress.jsonl` at runtime.
6. Enable sanitizers and debug symbols when they fit the target language and build system.
7. Build the executable fuzzer. Capture stdout/stderr into log files under the task directory.
8. Return the structured result and route requested by the stage prompt.

## Required LibAFL Shape

A successful build must be a real LibAFL fuzzing campaign, not a hand-written
mutation loop, smoke test, one-shot replay, or wrapper that only calls the
target once. Do not mark the build as `built` unless the generated source uses
LibAFL components such as `StdFuzzer`, `StdState`, an `Executor`, an
`EventManager`, and a `Monitor`.

The generated fuzzer must use `JSONLPrintingMonitor` to write monitor records
to `/task/fuzz-progress.jsonl`. Do not rely on `SimpleMonitor` alone. If stdout
monitoring is useful, combine it with `JSONLPrintingMonitor` so the JSONL file
is still produced.

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
`inputModel`, `expectedOracle`, `seedCorpusPath`, whether the fuzzer uses
LibAFL, whether it uses `JSONLPrintingMonitor`, the progress path, notes, and
artifact paths.

## Build Decision

Choose the success path only when the executable was built and can be run.
Choose the analysis-feedback path when the build failed, the request is not
actionable, the harness would not exercise the requested path, or the generated
program is not a complete LibAFL fuzzer that writes `/task/fuzz-progress.jsonl`
through `JSONLPrintingMonitor`.
