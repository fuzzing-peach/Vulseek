---
name: repository-scanner
description: Build a repository-wide overview for full scan. Identify runtime scope, languages, build systems, attack surfaces, vulnerability themes, and a module partition plan. Write repository-level artifacts only. Do not write final merged candidates.
---

# Repository Scanner

Use this skill when Dokploy starts the repository-level scanner for a full-scan job.

Your job is to understand the repository at a coarse but security-focused level and produce repository-level artifacts for downstream module scanners.

This layer must do three things before module planning is considered complete:

1. pull recent repository security intelligence
2. map the repository structure and derive the module partition plan
3. initialize Serena in the repository and build its index for downstream scanners

## Non-Goals

Do not:

- write final merged candidate JSON
- do deep vulnerability confirmation
- do per-function scanning
- do final prioritization across candidate sites

## High-Level Tasks

1. pull recent CVE, PR, and issue intelligence for this repository or product
2. identify repository purpose and major runtime components
3. identify languages and build systems
4. identify runtime vs non-runtime directories
5. identify main trust boundaries and attack surfaces
6. identify vulnerability classes worth prioritizing for this repository
7. partition the repository into functional scan modules
8. initialize Serena in the repository and build an index that downstream scanners can reuse

## External Code And Nested Repository Exclusion

By default, do not treat external code trees as first-class scan scope.

You must explicitly detect and avoid:

- git submodules declared in `.gitmodules`
- nested repositories or directories containing their own `.git`
- third-party dependency trees such as `third_party/`, `vendor/`, `deps/`, `external/`, `submodules/`
- generated SDKs, imported mirrors, vendored copies, and package-manager cache trees

Default rule:

- do not partition external code into normal scan modules
- do not spend repository-scanner effort mapping internal structure of excluded trees
- do not let excluded trees dominate repository summary, attack surface summary, or module planning

Exception rule:

- if the main repository directly executes, links, or exposes the external tree in a runtime-critical path, you may keep a narrow note about it
- only include such a tree in module planning when it is clearly part of the effective runtime attack surface for the checked-out target
- when you include it, explain why it could not be safely down-ranked

Required output behavior:

- record excluded or down-ranked external trees in `downrankedDirectories`
- mention detected submodules, nested repos, or vendored trees in `notes`
- keep module planning focused on first-party runtime code unless the exception rule applies

## Required Execution Order

Run the following phases in order.

### Phase 1: Repository Security Intelligence

Before scanning code structure, collect recent external signals that provide security context.

You must:

1. pull recent CVEs relevant to the project or repository
2. pull recent security-relevant PRs, bug-fix PRs, hardening PRs, and regression PRs
3. pull recent issues related to crashes, parsing, validation, memory safety, authentication, verification, race conditions, lifetime bugs, or other security-adjacent failures

Preferred sources and tools:

- use the `search-registries` skill tools for CVEs and PRs
- use repository issue search through GitHub web/API or equivalent CLI available in the environment
- prefer recent results first, but include older high-signal issues if they are clearly recurring themes

Required output of this phase:

- summarize the main recurring bug and vulnerability themes
- record whether results came from cache, refresh, or fresh fetch

At minimum, capture:

- recent CVE IDs and one-line themes
- PR titles or numbers that indicate hardening, incomplete fixes, or regressions
- issues that suggest exposed attack surfaces, fragile subsystems, or recurring bug classes

### Phase 2: Repository Structure And Module Planning

After external intelligence, perform the repository overview and module partitioning work.

You must:

1. identify top-level runtime directories and major subsystems
2. identify language and build-tool boundaries
3. identify public APIs, protocol parsers, config loaders, file parsers, IPC or CLI entrypoints, plugin systems, and callback-heavy subsystems
4. identify trust boundaries and likely attack surfaces
5. identify vulnerability classes worth prioritizing for this codebase
6. partition the repository into meaningful functional modules for module scanners

Module count rule:

- by default, produce at least 10 functional modules
- only produce fewer than 10 modules when the repository is genuinely too small or too tightly coupled to support a defensible split
- if you produce fewer than 10 modules, explicitly explain why in `notes`
- do not collapse unrelated runtime subsystems into one broad catch-all module just to stay conservative
- prefer narrower subsystem modules when a codebase contains distinct parser, protocol, validation, crypto, storage, API, daemon, CLI, or compatibility layers

Module boundaries should follow real subsystem boundaries such as:

- protocol/runtime layers
- parser families
- certificate or policy verification stacks
- storage or configuration layers
- provider or plugin subsystems
- public library API families
- daemon, server, client, or CLI runtime paths

Avoid partitioning primarily by:

- test directories
- docs
- examples
- generated files
- packaging-only files
- arbitrary equal-size slicing

Also avoid partitioning external or imported code trees as normal modules unless the exception rule above applies.

### Phase 3: Serena Initialization And Indexing

After the repository structure and module plan are stable enough, initialize Serena inside the repository so downstream scanners can reuse symbol-aware navigation.

You must:

1. ensure the current working directory is the repository root
2. initialize Serena for this repository if it is not already initialized
3. build or refresh the Serena index
4. verify that Serena can answer basic project queries after indexing

Use Serena to support later structure and module mapping, not as a substitute for repository planning.

Minimum expected actions:

- initialize the project in Serena
- run Serena indexing
- confirm the index is usable

Also record Serena initialization status inside the final structured result notes when relevant.

## Final Structured Result

Generate the final structured result in the correct JSON format for this run and make sure it satisfies the runtime-provided `output.schema.json`.

Rules:

- use the runtime-provided `output.schema.json` as the source of truth
- validate the final JSON against `output.schema.json` before returning
- do not write extra structured result files such as `repository_scan.json`, `module_plan.json`, `recent_cve.json`, `recent_prs.json`, or `recent_issues.json`
- return the validated JSON inside `<VULSEEK_RET>...<VULSEEK_RET>`
- the `<VULSEEK_RET>...<VULSEEK_RET>` payload must contain only the validated JSON object and no extra prose
- keep values concise and repository-level
- record the repository overview, runtime-relevant structure, attack surfaces, vulnerability themes, and notes about excluded or down-ranked trees
- do not include markdown fences, comments, trailing explanatory text, or any non-JSON content

## Working Style

- when locating code, functions, symbols, callers, or related files, prefer Serena first
- prefer `rg`, `find`, `sed`, `awk`
- after Serena indexing is available, use Serena as the default tool for symbol-aware lookup
- use `rg`, `find`, `sed`, and `awk` as fallback tools for broad text search, file discovery, or when Serena is unavailable
- keep the overview concise but structured
- bias toward runtime-relevant code
- down-rank docs, examples, tests, generated code, and packaging unless they are part of the runtime threat surface
- cross-check repository structure conclusions against recent CVEs, PRs, and issues
- if historical signals repeatedly mention a subsystem, increase its module priority

## Final Rule

This layer produces context and module planning only.

It does not write final merged candidates.
