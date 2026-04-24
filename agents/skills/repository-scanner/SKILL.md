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

## Required Outputs

Write these files when the runtime provides their paths:

- `repository_scan.md`
- `repository_scan.json`
- `module_plan.json`

When useful, also write supporting notes in the repository artifact directory, for example:

- `recent_cve.json`
- `recent_prs.json`
- `recent_issues.json`
- `serena_setup.md`

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
- save the raw or summarized results to repository-level artifacts when paths are available

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

Record in `serena_setup.md`:

- whether initialization was newly created or reused
- whether indexing succeeded
- any indexing gaps, unsupported languages, or backend limitations

## What `repository_scan.json` Should Capture

- repository summary
- languages
- build systems
- runtime directories
- skipped or down-ranked directories
- attack surfaces
- major public APIs
- vulnerability themes
- notes about submodules or external stacks

### Fixed `repository_scan.json` Template

Use this fixed top-level structure:

```json
{
  "repository": {
    "name": "openssl",
    "summary": "TLS/crypto library with protocol, X.509, provider, and command-line tooling components."
  },
  "languages": [
    "c",
    "perl"
  ],
  "buildSystems": [
    "Configure",
    "make"
  ],
  "runtimeDirectories": [
    "ssl",
    "crypto",
    "providers"
  ],
  "downrankedDirectories": [
    "test",
    "demos",
    "doc"
  ],
  "attackSurfaces": [
    "network_protocol_parsing",
    "public_library_api",
    "certificate_parsing",
    "configuration_input"
  ],
  "publicApis": [
    "SSL_*",
    "EVP_*",
    "X509_*"
  ],
  "vulnerabilityThemes": [
    "parser_state_handling",
    "length_and_bounds_checks",
    "ownership_and_resource_lifecycle",
    "policy_and_verification_logic"
  ],
  "notes": [
    "Third-party or generated code was down-ranked unless used directly in runtime paths."
  ]
}
```

Rules:

- output exactly one top-level JSON object
- always include all top-level fields shown above
- use arrays, not free-form joined strings
- use `[]` when a field has no items
- keep values concise and repository-level

## What `module_plan.json` Should Capture

For each module:

- `moduleId`
- `name`
- `summary`
- `artifactDir`
- `pathListFile` when available
- `priority`

Keep modules meaningful but not too large. Prefer real runtime boundaries over arbitrary directory slicing.

### Fixed `module_plan.json` Template

Use this fixed top-level structure:

```json
{
  "modules": [
    {
      "moduleId": "tls-runtime",
      "name": "TLS Runtime",
      "summary": "Implements handshake, record, session, and protocol state transitions.",
      "artifactDir": "/scan-context/jobs/<scanJobId>/scanning/full_scan/modules/tls-runtime",
      "pathListFile": "/scan-context/jobs/<scanJobId>/scanning/full_scan/modules/tls-runtime/file_list.txt",
      "priority": 95
    }
  ]
}
```

Rules:

- output exactly one top-level object with a `modules` array
- every module object must include all six fields above
- `moduleId` must be stable and filesystem-safe
- `artifactDir` must point to that module's artifact directory
- `pathListFile` must point to a concrete `file_list.txt`
- `priority` should be an integer, higher means earlier scheduling
- prefer fewer, meaningful runtime modules over many tiny fragments

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

## What Must Appear In `repository_scan.md`

Include short sections for:

- repository purpose
- languages and build systems
- runtime directories and down-ranked directories
- attack surfaces and trust boundaries
- recent CVE / PR / issue themes
- Serena initialization and indexing status
- prioritized module plan rationale

## Final Rule

This layer produces context and module planning only.

It does not write final merged candidates.
