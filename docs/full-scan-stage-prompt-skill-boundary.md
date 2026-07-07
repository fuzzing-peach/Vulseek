# Full Scan Stage Prompt And Skill Boundary

Full-scan prompts follow one rule: stage prompts orchestrate a concrete runtime
task, and skill markdown explains how to do the work.

## Stage Prompt Responsibilities

Stage prompts may define:

- the agent role for this turn
- task inputs and IDs
- task and artifact paths
- required skills
- route mapping and route keys, without duplicating runtime-injected marker
  formatting instructions
- schema object choice constraints
- concise reminders to validate structured JSON against the runtime-provided
  `output.schema.json`
- concise lane lifecycle requirements, expressed as the `output.json` `exit`
  boolean
- small stage-specific output requirements, such as canonical object fields

Stage prompts should not duplicate investigation workflows, build procedures, or
review standards that belong in skills.

## Skill Responsibilities

Skill markdown may define:

- workflow and investigation method
- tool priority and fallback order
- vulnerability judgment standards
- artifact content requirements
- markdown report templates or required human-readable sections
- how to use helper skills, such as `tree-sitter`, `libafl`,
  `address-sanitizer`, and `coverage-analysis`

Skill markdown should not copy the runtime output protocol. Avoid repeating
`output.json` envelope syntax, route schema details, schema validation commands,
or full structured-output contracts. If a skill needs to mention final output,
it should defer the exact schema and return protocol to the stage prompt and
runtime contract.

## Runtime Return Protocol

The runtime injects the complete structured-output contract into each task
prompt and writes the complete schema envelope to `output.schema.json`. Agents
must write exactly one JSON envelope to `output.json`, then end the turn. Vulseek
uses the end-turn event as the completion signal and reads `output.json` after
that signal.

The `output.json` envelope has:

- `route`: the selected route key, or `null` for non-routed stages
- `exit`: whether the current lane/group should be released after the task
- `output`: the stage result object matching the schema for the selected route

No `VULSEEK_*` marker is part of the runtime protocol.

## Current Stage Mapping

- `RepositoryScanningStage` uses `repository-scanner`.
- `ModuleScanningStage` uses `module-scanner` and `tree-sitter`.
- `FunctionScanningStage` uses `function-scanner`.
- `AnalysisStage` uses `deep-analysis`.
- `FuzzBuildStage` uses `libafl-build`, with `libafl` and
  `address-sanitizer` as helper skills.
- `FuzzRunStage` uses `libafl-fuzz`, with `coverage-analysis` as a helper skill.
- `AnalysisCriticStage` uses `analysis-critic`.
- `VerifyingStage` uses `verify`.

## Scanner Layer Notes

`repository-scanner` owns repository intelligence, structure modeling, external
code down-ranking, module planning, and Serena initialization. The repository
stage prompt owns repository ref/commit inputs, the minimum module-count
constraint, schema validation, and lane exit.

`module-scanner` owns module interpretation and function prioritization. Function
inventory must come from the `tree-sitter` skill. The module stage prompt owns
the canonical module object requirement and lane exit.

`function-scanner` owns concrete candidate discovery for one function. The
function stage prompt owns the `{ "candidates": [] }` result shape and canonical
candidate schema.

## Analysis, Fuzzing, Critic, And Verification Notes

`deep-analysis` owns entry-to-candidate tracing, reachability, constraints,
fuzzing-hard path prioritization, API misuse judgment, and analysis report
content. The analysis stage prompt owns the schema choice and route keys:
`build_fuzzer`, `critic`, and `verification`.

`libafl-build` owns harness construction, LibAFL crate layout, sanitizer-aware
builds, and build artifacts. The fuzz build stage prompt owns the
`BuildFuzzerRequest` input and `run_fuzzer` or `analysis` route mapping.

`libafl-fuzz` owns budgeted execution, corpus/crash/log collection, coverage
feedback, and triggering-input judgment. The fuzz run stage prompt owns the
budget input and route back to `analysis`.

`analysis-critic` owns adversarial review and convinced/objected standards. The
critic stage prompt owns the draft-analysis input, analysis fingerprint, and
route back to `analysis`.

`verify` owns final verification, historical CVE/PR/issue checks, API misuse
review, PoC and Docker reproduction artifacts, issue draft, and verification
report content. The verification stage prompt owns final-analysis input,
critic-approval requirement, artifact paths, and verification schema fields.
