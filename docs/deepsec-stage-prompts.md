# Deepsec Stages And Prompt Intent

This note summarizes the stage model in `third_party/deepsec` and the intent expressed by each prompt. Deepsec is not implemented as an explicit DAG. Its pipeline is driven by CLI subcommands plus the on-disk `FileRecord` state under `data/<projectId>/`.

The main flow is:

```text
scan -> process -> revalidate -> enrich -> export/report/metrics
```

## Setup And Project Context

`init` and `init-project` are not vulnerability-analysis stages, but they create the `.deepsec` workspace and per-project files such as `INFO.md` and `SETUP.md`.

The setup prompt asks a coding agent to read Deepsec's skill docs, skim the target repository, and write concise project context. That context later becomes prompt input for `process`, `triage`, and `revalidate`.

`INFO.md` is therefore an important prompt component. It usually records the project's trust boundaries, accepted risks, known false positives, and code areas worth paying attention to.

## scan

`scan` has no LLM prompt.

Its job is to glob the project root, run regex and plugin matchers, and write candidate matches into each file's `FileRecord`. It also detects the repository's technology stack so later prompt assembly can include framework-specific security hints.

The stage is intentionally high-recall and low-cost. It does not decide whether a vulnerability is real. It only produces candidate sites and leaves actual reasoning to `process`.

## process

`process` is the main AI investigation stage.

It selects pending or explicitly requested files, batches them, and sends each batch to the configured agent backend. The prompt is assembled from several pieces:

- Generic security researcher core prompt.
- Technology-stack threat highlights selected from detected repo tags.
- Vulnerability-slug-specific reviewer notes for the current batch.
- Project `INFO.md`.
- Optional `config.json:promptAppend`.
- The concrete target files and scanner hits for this batch.
- Investigation instructions and the required JSON output schema.

The prompt tells the agent to treat scanner hits only as starting points. The agent is expected to read each file fully, trace data flow, follow imports, inspect middleware and helpers, check mitigations, and think beyond the original matcher result.

The output is a JSON findings array. Each file must appear in the result. If no real vulnerability is found, the file still appears with an empty `findings` array.

Each finding contains:

- `severity`
- `vulnSlug`
- `title`
- `description`
- `lineNumbers`
- `recommendation`
- `confidence`

`process --diff` uses the same investigation prompt. The difference is only the input selection: it first scans changed files and then sends exactly those files into `process`, including files that had no matcher hits.

## triage

`triage` is a lightweight priority-classification stage.

It does not rediscover vulnerabilities and does not ask the model to read code. Its prompt receives existing findings and asks the model to classify each one by remediation priority:

- `P0`: fix immediately.
- `P1`: fix soon.
- `P2`: fix eventually.
- `skip`: not actionable.

It also asks for exploitability, impact, and a short reasoning string.

The prompt's function is operational prioritization. It helps decide which findings are urgent enough to interrupt engineering work and which ones can be deferred or ignored.

## revalidate

`revalidate` is the adversarial review stage for existing findings.

Its prompt asks the agent to behave like a careful security researcher and determine whether each finding is actually real and exploitable. The agent must perform static analysis only. It should not run the target code, exploit the issue, or send requests.

For every finding, the prompt asks the agent to:

- Read the full target file.
- Read relevant imports, middleware, auth utilities, validation helpers, and framework pipeline code.
- Trace the data flow end to end.
- Construct a concrete attacker scenario.
- Check framework-level protections.
- Compare the current code with the original finding and recent git history.
- Use `uncertain` when the evidence is insufficient.

The output verdicts are:

- `true-positive`
- `false-positive`
- `fixed`
- `uncertain`

The output may also include `adjustedSeverity` when the original severity is wrong. The reasoning field is treated as the most important part of the verdict.

## enrich

`enrich` has no security-analysis prompt.

It reads existing findings and attaches git committer information plus optional ownership data from plugins. Its purpose is to turn findings into assignable work items.

## report, export, metrics, and status

These stages do not use LLM prompts.

`report` generates a project-level Markdown and JSON summary.

`export` writes findings as JSON or as a directory of per-finding Markdown files.

`metrics` computes cross-project counts, severity rollups, revalidation status, triage distribution, and cost/token summaries.

`status` shows the current state of the project mirror.

These commands are presentation and data-shaping stages. They do not modify the security reasoning itself.

## sandbox and sandbox-all

`sandbox` and `sandbox-all` are execution-environment wrappers, not new analysis stages.

They run existing Deepsec commands inside Vercel Sandbox microVMs. The underlying prompts remain the prompts from `process`, `revalidate`, or `triage`.

The important security distinction is that sandbox output is treated as external data that later has to be collected and merged back into the host workspace.

## Refusal Follow-up

After `process` and `revalidate`, Deepsec can ask a short QA follow-up prompt. This prompt asks whether the agent refused, skipped, or failed to fully analyze anything.

This is not a vulnerability-analysis prompt. It is a quality-control signal used to detect incomplete analysis caused by model refusal or scope discomfort.

## Overall Model

Deepsec separates broad candidate discovery from expensive reasoning:

- `scan` finds possible sites cheaply.
- `process` performs the main open-ended security analysis.
- `triage` ranks confirmed findings for remediation.
- `revalidate` reduces false positives and detects fixed issues.
- `enrich` adds ownership and git context.
- `report`, `export`, `metrics`, and `status` present or summarize the accumulated state.

The prompt-heavy stages are `process`, `triage`, and `revalidate`. The other stages are deterministic data-processing or execution-wrapper stages.
