---
name: scan-module
description: Extract functions from one module and produce broad function artifacts for downstream function scanning.
---

# Scan Module

## Purpose

Scan one assigned module and produce function-level scan tasks.

This stage is recall-oriented.

The goal is to collect functions that may contain or influence vulnerability candidates, not to verify vulnerabilities.

This stage should remove obvious noise, not shrink the inventory to a small set.

Every concrete in-scope function body should either become a function artifact or be omitted for a concrete exclusion reason below.

Do not cap, summarize, or compress the extracted inventory into a smaller function set.

## Inputs

Use the paths, runtime metadata, and Zod schemas provided by the stage prompt.

Expected inputs include:

- repository-level artifact
- one module artifact
- checked-out repository
- function artifact directory
- output manifest path

A module is not an exclusive ownership partition.

Modules may overlap. Shared files or shared functions are valid when they matter to this module's security model, local behavior, or downstream inspection context.

## Outputs

Write the artifacts required by the stage prompt:

- normalized module artifact
- one function artifact per kept concrete function
- output manifest

Use the injected Zod schemas as the source of truth.

Do not write final vulnerability candidates.

Do not embed function objects inside the module artifact.

## Workflow

Follow this workflow:

1. Read repository and module artifacts.
2. Normalize the module file scope.
3. Exclude external, vendored, generated, test-only, or unrelated paths.
4. Use tree-sitter to extract concrete function definitions from in-scope files.
5. Manually sanity-check extracted function identities.
6. Infer each function's likely semantic role from lightweight local signals.
7. Apply the required noise-exclusion pass below.
8. Write one function artifact for every remaining concrete function.
9. Write the normalized module artifact and output manifest.
10. Validate all artifacts.

## Scope

Focus on first-party code in the assigned module.

Avoid unrelated nested repositories, git submodules, vendored dependencies, generated mirrors, and external code trees unless the module or repository artifact explicitly marks them as part of the runtime attack surface.

If external or generated code is intentionally kept in scope, explain the reason briefly in module notes.

When building the final function list, do not let imported or vendored trees flood the output.

Prefer first-party module files even if external trees are physically adjacent in the filesystem.

## Function Inventory

Use the installed `tree-sitter` skill as the primary function inventory method.

The extracted function list is the starting point.

If tree-sitter fails for some files, continue with successfully extracted functions and record a short note.

Use repository-relative paths when possible.

## Function Identity Verification

Do not blindly trust extracted function names.

After extracting functions with tree-sitter or any fallback tool, manually sanity-check the results before writing artifacts.

Verify that each kept function has the correct name, file path, line range, enclosing scope, and actual function body.

If names or ranges look wrong, adjust the extraction method, query pattern, parser mode, file filters, or fallback lookup tools until the function identity is reliable enough.

Exclude declarations, prototypes, macro expansions, stubs, and incorrectly extracted symbols when they do not correspond to real function bodies.

If extraction remains partially unreliable, continue with verified functions and record a short note.

## Function Semantic Inference

For each extracted function, infer its likely role using lightweight local signals:

- function name
- file path
- enclosing type or class, if available
- signature and parameter names
- return type
- nearby comments
- nearby macro or export annotations
- nearby sibling function names

Prefer broad semantic inference over deep source analysis.

Useful semantic labels include:

- parse / decode / deserialize / import / load
- validate / verify / check / authorize / authenticate
- sanitize / normalize / canonicalize / escape
- read / write / send / receive / connect / accept
- open / close / create / delete / update
- allocate / free / init / cleanup / reset
- copy / move / append / resize / convert
- dispatch / handle / process / execute / invoke
- configure / set / enable / disable / register
- encrypt / decrypt / sign / hash / random / key
- state / transition / retry / fallback / error
- callback / hook / plugin / tool / sandbox
- admin / permission / policy / session / token

## Function Inclusion Policy

This stage uses exclusion-based inclusion.

Start from all concrete functions extracted by tree-sitter.

Default behavior: keep the function.

For a first-party module file, thousands of function artifacts are acceptable when the module has thousands of concrete functions.

Do not create a small function set, capped function set, summary set, or theme-based subset.

## Required Noise-Exclusion Pass

You must omit concrete functions that clearly match one of these low-value patterns:

- out-of-scope external, vendored, generated, or test-only functions
- trivial getters, setters, constant returns, or empty stubs
- simple logging, tracing, metrics, or debug helpers
- pure formatting helpers with no security-relevant output
- pure wrappers that only forward arguments without changing validation, state, flags, options, or control flow
- unrelated compatibility shims with no meaningful local behavior
- method/version constructor functions that only return a fixed static method table or constant descriptor
- feature-probe functions that only return a compile-time constant or a simple boolean flag
- stack/list/object boilerplate that only allocates, frees, duplicates, pushes, pops, or returns a field without validation, parsing, policy, memory-copy complexity, or state transitions
- short option accessors that only set or read one field and do not change policy, validation, callbacks, trust, credentials, I/O, crypto, parser, or session state

Use lightweight body inspection for functions whose name suggests obvious boilerplate, especially:

- `get`, `set`, `is`, `has`, `new`, `free`, `dup`, `push`, `pop`, `num`, `value`, `method`, `version`
- OpenSSL compatibility wrappers
- stack/list helpers
- debug, trace, print, statistics, and string-name helpers

Keep the function if the body contains any of these signals:

- parses, decodes, normalizes, imports, loads, or processes structured data
- validates, verifies, checks, authorizes, authenticates, or enforces policy
- reads, writes, sends, receives, connects, accepts, or dispatches I/O
- copies, moves, appends, resizes, indexes, bounds-checks, allocates with nontrivial ownership, or frees state involved in callbacks/lifecycles
- configures security behavior, trust, credentials, callbacks, protocol versions, ciphers, curves, signatures, or options with policy impact
- performs or prepares crypto, key schedule, random, MAC, hash, signature, certificate, session, ticket, or secret handling
- changes protocol, parser, handshake, retry, fallback, timeout, error, or session state

Keep functions that may process input, validate data, enforce policy, touch sensitive operations, manipulate memory or resources, manage state, handle errors, configure security behavior, register callbacks, dispatch behavior, or influence nearby security-relevant code.

When uncertain, keep the function with lower priority or a short note.

The goal is to remove obvious noise, not to keep only high-confidence targets.

The `output.functions` manifest must include every kept concrete function artifact. Its length should match the number of kept concrete functions, not the number of themes or subareas.

Record exclusion statistics in the module notes:

- extracted concrete function count
- kept function count
- omitted function count
- main omission categories

## Priority Policy

Assign numeric priority according to likely downstream inspection value.

- `0`: strong local signals of security-sensitive behavior
- `1`: likely input processing, validation, policy, state, or sensitive operation logic
- `2`: indirect security influence, wrapper, glue, comparison, or useful context
- `3`: low-confidence but not clearly excludable

Priority is an ordering hint for downstream scheduling, not a vulnerability judgment.

## Module Artifact Rules

Write a concise normalized module artifact using the injected module schema.

Keep it limited to module-stage facts and notes useful for downstream function scanning.

Do not write final vulnerability findings.

## Function Artifact Rules

Write each kept concrete function as a separate JSON artifact under the function artifact directory required by the stage prompt.

Each function artifact should briefly state:

- extracted function identity
- file path and line range when available
- inferred semantic role
- why it was kept
- priority
- useful local context files when available

Use tree-sitter extracted symbol identity first.

Use repository-relative paths when possible.

Do not embed function objects inside the module artifact.

## Lookup Policy

Use tools by purpose:

1. Use tree-sitter for concrete function inventory.
2. Use Serena for symbol-aware lookup and navigation when available.
3. Use `rg`, `find`, `sed`, `awk`, or `semgrep` only as fallback or lightweight support.

Do not turn lookup into global program analysis.

## Boundaries

This stage extracts and filters function scan tasks.

It does not verify vulnerabilities, produce final vulnerability candidates, perform taint analysis, build call graphs, run CodeQL, run fuzzing, run builds, or run tests.

Use lightweight semantic inference only.

If uncertain, prefer inclusion.

## Validation

Before finishing, validate that:

- the normalized module artifact exists
- the output manifest exists
- all function artifacts are parseable JSON
- all artifacts conform to the injected schemas
- every kept function came from tree-sitter extraction unless a fallback is explicitly noted
- kept function identities were sanity-checked
- output.functions includes every kept concrete function artifact
- excluded external, generated, test-only, or vendored paths did not flood the output
- no final vulnerability result is written

If validation fails, fix the artifacts once.
