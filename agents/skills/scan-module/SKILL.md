---
name: scan-module
description: Normalize one module artifact and produce bounded function artifacts for downstream function scanning.
---

# Scan Module

## Purpose

Scan one repository module and create function-level scan tasks for the next stage.

This stage is a function candidate extraction stage, not a vulnerability verification stage.

It should understand the assigned module enough to identify functions worth deeper inspection.

It must produce:

- a normalized module artifact
- separate function artifacts under `/task/functions/`
- an output manifest defined by the stage prompt

Use the schemas injected by the stage prompt as the source of truth.

## Inputs

Use the paths, runtime metadata, and schemas provided by the stage prompt.

Expected inputs include:

- repository-level artifact
- one module artifact
- checked-out repository
- function output directory
- output manifest path

A module is not an exclusive ownership partition.

Modules may overlap. Shared files or shared functions are valid when they matter to this module's entrypoints, trust boundaries, validation stack, or security responsibilities.

## Scope

Focus on first-party code in the assigned module.

Avoid unrelated nested repositories, git submodules, vendored dependencies, generated mirrors, and external code trees unless the module or repository artifact explicitly marks them as part of the runtime attack surface.

If external or generated code is intentionally kept in scope, explain the reason briefly in module notes.

## Workflow

Follow one pass:

1. Read repository and module artifacts.
2. Normalize the module file scope.
3. Exclude external, vendored, generated, or unrelated nested repository paths.
4. Use `tree-sitter` to extract concrete function definitions from in-scope files.
5. Inspect limited surrounding context to understand module-level risk signals.
6. Select and prioritize functions worth downstream inspection.
7. Write one function artifact per selected function.
8. Write the normalized module artifact and output manifest.
9. Validate all artifacts.

## Function Inventory

Function extraction must be tool-driven.

Use the installed `tree-sitter` skill as the primary function inventory method.

Use tree-sitter extracted symbol identity first.

If tree-sitter fails for some files, continue with successfully extracted functions and record a short note.

Text search tools may support lookup and context gathering, but they must not replace tree-sitter as the primary function inventory source when tree-sitter is available.

## Lookup Policy

Use tools by purpose:

1. Use `tree-sitter` for concrete function inventory.
2. Use Serena for symbol-aware lookup and navigation when available.
3. Use `rg`, `find`, `sed`, `awk`, or `semgrep` only as fallback or lightweight support.

Do not turn lookup into global program analysis.

## Function Selection Policy

Select functions that may contain or influence vulnerability candidates worth deeper function-stage inspection.

This stage may use vulnerability-oriented reasoning to choose functions, but it must not confirm vulnerabilities.

Select a function when one or more of the following apply:

1. It reaches or guards a sensitive operation

   The function performs, authorizes, validates, wraps, or dispatches security-sensitive behavior such as authentication, authorization, session or token handling, permission checks, secret handling, cryptography, payments, database writes, filesystem access, network requests, command execution, plugin execution, tool execution, or privileged state changes.

2. It performs parser, decoder, validator, sanitizer, or policy logic

   The function parses, decodes, deserializes, imports, normalizes, validates, verifies, sanitizes, checks bounds, enforces policy, handles resource lifecycle, or transforms data before it reaches a sensitive operation.

3. It connects security-relevant control or data flow

   The function is glue code, dispatcher code, middleware, adapter logic, or service-layer code that connects module boundaries, validation logic, policy checks, storage layers, execution layers, or other sensitive operations.

4. It matches common vulnerability-prone patterns

   Prioritize functions that appear related to:

   - injection
   - path traversal
   - SSRF
   - unsafe deserialization
   - authentication bypass
   - authorization bypass
   - confused deputy
   - insecure direct object reference
   - file upload handling
   - command execution
   - unsafe dynamic evaluation
   - template rendering
   - XSS or HTML/script generation
   - CSRF-sensitive state changes
   - cryptographic misuse
   - signature or certificate verification
   - race conditions
   - resource exhaustion
   - memory safety
   - integer overflow or bounds errors
   - unsafe pointer or buffer handling
   - sandbox escape
   - plugin or extension abuse
   - LLM prompt injection
   - tool permission bypass
   - data exfiltration

5. It is useful supporting evidence for another candidate

   Include a lower-priority function when it implements validation, sanitization, authorization, safe handling, dispatch, or policy behavior that another selected candidate depends on.

Do not select functions merely because they exist.

Do not emit a full function inventory as scan tasks.

For each selected function, explain why it may contain or influence a vulnerability candidate.

The explanation should describe the suspected risk shape, not claim that a vulnerability is confirmed.

Use cautious language such as:

- "may be vulnerable if..."
- "worth inspecting because..."
- "appears to handle..."
- "may influence..."
- "possible risk area..."

Avoid confirmed-judgment language such as:

- "is vulnerable"
- "confirmed"
- "exploitable"
- "allows attacker to..."
- "root cause is..."

Confirmed vulnerability judgment belongs to the function stage.

## Priority Policy

Assign function priority numerically.

- `0`: externally reachable and security-critical
- `1`: trust-boundary, parser, validator, dispatcher, or sensitive sink logic
- `2`: important internal runtime logic
- `3`: low-priority support or negative-evidence target

Do not confirm vulnerabilities in this stage.

Priority means “worth inspecting next,” not “vulnerable.”

## Function Artifact Rules

Write each selected function as a separate JSON artifact under `/task/functions/`.

Each function artifact must satisfy the injected runtime function schema.

Each function artifact should explain briefly:

- what the function is
- why it matters to this module
- why it should be inspected next
- how it appears reachable, or why reachability is limited
- which files provide useful local context

Use repository-relative paths when possible.

Do not embed function objects inside the module artifact.

## Module Artifact Rules

Write a concise normalized module artifact using the injected module schema.

Keep it focused on module-stage facts:

- module summary
- normalized important files
- module-level entrypoints or risk signals, if schema allows
- notes useful for downstream function scanning

Do not include final vulnerability findings.

Do not include exploit hypotheses.

Do not include detailed attack paths.

## Boundaries

Stay within the module-stage contract.

This stage extracts and prioritizes function scan tasks.

It does not verify vulnerabilities, write final merged candidates, run heavy static analysis, run fuzzing, build call graphs, or perform full data-flow analysis.

It should use limited local context only as needed to prioritize functions.

If uncertain, record a short note and continue.

Prefer useful bounded function tasks over exhaustive module understanding.

## Validation

Before finishing, validate that:

- the normalized module artifact exists
- the output manifest exists
- all written JSON artifacts are parseable
- all artifacts conform to the injected schemas
- every selected function came from tree-sitter extraction unless a fallback is explicitly noted
- excluded external or vendored paths did not flood the function list
- function artifact paths are repository-relative where possible
- no final vulnerability result is written

If validation fails, fix the artifacts once.

Refine function selection only when validation requires it.
