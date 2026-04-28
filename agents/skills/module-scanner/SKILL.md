---
name: module-scanner
description: Build a module-level scan result for full scan. Use repository-level context, identify module responsibility and local attack surfaces, and produce a function plan for downstream function scanners. Do not write final merged candidates.
---

# Module Scanner

Use this skill when Dokploy starts a module-level scanner for one module inside a full-scan job.

Your job is to understand one module and generate function-level scan tasks.

Function extraction must be tool-driven, not free-form.

Use the installed skill named `tree-sitter`.

## Inputs

You should be given:

- repository-level scan artifacts
- one module definition
- the checked out repository
- output paths for module artifacts

## External Code And Nested Repository Exclusion

Default assumption:

- the assigned module should focus on first-party code from the current repository
- do not expand scope into unrelated nested repositories, git submodules, or vendored dependency trees

You must explicitly avoid scanning or extracting functions from:

- paths declared as git submodules in `.gitmodules`
- directories containing their own `.git`
- common external-code roots such as `third_party/`, `vendor/`, `deps/`, `external/`, `submodules/`
- generated or mirrored code trees unless the module definition explicitly includes them

Exception rule:

- if the module definition or repository-level artifacts explicitly say that a vendored or external tree is part of the runtime attack surface, you may keep it in scope
- if you do so, state the reason clearly in `module_scan.md` and `module_scan.json`

Practical rule:

- when building `function_plan.json`, do not let imported or vendored trees flood the function list
- prefer first-party module files even if external trees are physically adjacent in the filesystem
- if tree-sitter returns functions from excluded paths, filter them out before producing the final plan

## Non-Goals

Do not:

- write final merged candidate JSON
- fully verify vulnerabilities
- do heavy CodeQL or fuzzing work

## Required Outputs

Write these files when the runtime provides their paths:

- `module_scan.md`
- `module_scan.json`
- `function_plan.json`

## Function Extraction Requirement

Use `tree-sitter` to extract concrete function definitions from the module file list, then transform the extracted functions into `function_plan.json`.

Rules:

- prefer calling `extract_functions.py` first for function inventory generation
- do not manually invent the function list from memory
- do not rely on loose grep-only heuristics when tree-sitter extraction is available
- if tree-sitter extraction fails for some files, note the failure and continue with the successfully extracted functions
- current expected first-class language support is C/C++
- if tree-sitter extracts functions from excluded external paths, remove them from the final plan unless the exception rule applies

Preferred invocation:

```bash
python3 /opt/dokploy-agents/tools/extract_functions.py \
  --file-list <file-list.txt> \
  --out <output.json>
```

## Lookup Priority

For code lookup, function lookup, caller lookup, and symbol navigation:

1. prefer Serena first
2. use `tree-sitter` for concrete function inventory generation
3. use `rg`, `find`, `sed`, `awk`, or `semgrep` only as fallback or light support

Do not default to raw grep when Serena can answer the question more precisely.

## High-Level Tasks

1. summarize what the module does
2. identify module entry points and trust boundaries
3. identify important files and local vulnerability themes
4. enumerate functions worth deeper scanning
5. create a function task plan

## What `module_scan.json` Should Capture

- module summary
- important files
- entry points
- trust boundaries
- local attack surfaces
- vulnerability themes
- notes about skipped areas
- notes about excluded external paths when relevant

### Fixed `module_scan.json` Template

Use this fixed top-level structure:

```json
{
  "module": {
    "moduleId": "tls-runtime",
    "name": "TLS Runtime",
    "summary": "Handles TLS handshake, record processing, session state, and related certificate paths."
  },
  "importantFiles": [
    "src/tls.c",
    "src/ssl.c"
  ],
  "entryPoints": [
    "DoTls13Handshake",
    "ProcessReply"
  ],
  "trustBoundaries": [
    "network_input",
    "certificate_input"
  ],
  "attackSurfaces": [
    "record_parsing",
    "handshake_state_transition"
  ],
  "vulnerabilityThemes": [
    "state_machine_consistency",
    "bounds_checks",
    "resource_cleanup"
  ],
  "notes": [
    "Generated compatibility glue was down-ranked."
  ]
}
```

Rules:

- output exactly one top-level object
- always include all top-level fields above
- `module.moduleId`, `module.name`, and `module.summary` are mandatory
- use arrays for list-like fields, never comma-joined strings
- use `[]` if a list is empty

## What `function_plan.json` Should Capture

For each function task:

- `functionId`
- `functionName`
- `filePath`
- `line`
- `priority`
- `summary`
- `riskType` when clear

The function list should be based on tree-sitter extracted definitions first, then filtered and prioritized by the module scanner.

Include functions that are:

- externally reachable
- security-sensitive
- parsers, validators, decoders, importers
- resource lifecycle or state-machine code
- auth, permission, signature, certificate, key handling code
- wrappers around dangerous sinks
- suspiciously inconsistent with sibling functions

### Fixed `function_plan.json` Template

Use this fixed top-level structure:

```json
{
  "module": {
    "moduleId": "tls-runtime",
    "name": "TLS Runtime"
  },
  "functions": [
    {
      "functionId": "fn-2f6e4d4d8a9a6f12",
      "functionName": "DoTls13Handshake",
      "filePath": "src/tls13.c",
      "line": 412,
      "priority": 93,
      "summary": "Processes TLS 1.3 handshake state transitions from untrusted peer messages.",
      "riskType": "state_machine"
    }
  ]
}
```

Rules:

- output exactly one top-level object with `module` and `functions`
- every function entry must include all seven fields above
- `priority` must be an integer
- `filePath` should be repository-relative when possible
- `functionId` should come from tree-sitter extraction first, not be invented manually
- do not output an empty object; use `"functions": []` if none survive filtering

## Working Style

- prefer Serena for symbol-aware code and function lookup
- use `tree-sitter` for function extraction
- use `rg`, `find`, `sed`, `awk` as fallback text/file search
- use `semgrep` only for light support
- focus on good task decomposition, not final findings
- do not over-prune function tasks at this stage

## Final Rule

This layer produces module context and function planning only.

It does not write final merged candidates.
