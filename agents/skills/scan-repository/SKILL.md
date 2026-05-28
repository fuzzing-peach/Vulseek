---
name: scan-repository
description: Build repository context and split the repository into bounded downstream scan modules.
---

# Scan Repository

## Purpose

Create repository-level context and split the checked-out repository into bounded modules for downstream scanning.

This stage is a routing stage. It should understand the repository just enough to create useful module tasks.

This stage may use lightweight threat-model reasoning to choose module boundaries, but it must not generate vulnerability candidates or confirmed findings.

## Inputs

Use the paths, runtime metadata, and schemas provided by the stage prompt.

Expected inputs include:

- checked-out repository
- task directory
- repository state
- output schema
- repository artifact path
- module artifact directory
- output manifest path

## Outputs

Write the artifacts required by the stage prompt:

- repository artifact
- module artifacts
- output manifest

Use the injected schemas as the source of truth.

The output manifest must contain artifact paths only, not embedded artifact objects.

## Workflow

Follow one pass:

1. Read repository metadata.
2. Inventory the repository structure.
3. Detect repository context.
4. Identify runtime and downranked areas.
5. Inspect limited representative source content.
6. Split the repository into modules.
7. Assign module priority.
8. Write artifacts.
9. Validate artifacts.

## Module Splitting Policy

Create modules that are useful downstream scan units.

A module should group code that shares a similar runtime role, trust boundary, threat model, or security responsibility.

Prefer boundaries in this order:

1. Explicit ownership boundaries

   Use repository-defined boundaries when they exist:

   - app
   - package
   - service
   - crate
   - contract
   - program
   - binary
   - deployable component

2. Entry and trust boundaries

   Split code where untrusted or less-trusted input enters the system or crosses into a more-trusted context.

   Consider:

   - HTTP, RPC, CLI, webhook, queue, worker, browser, plugin, LLM tool, or smart contract entrypoints
   - user input, network input, uploaded files, parsed documents, queue messages, third-party API responses, database-loaded state, environment variables, filesystem state, plugin output, or LLM output

3. Sensitive responsibility boundaries

   Split code that performs, guards, or validates security-sensitive behavior.

   Consider:

   - authentication, authorization, sessions, tokens, admin actions, permission checks
   - database writes, filesystem access, command execution, network requests
   - cryptography, payments, billing, secrets, tool execution, plugin execution
   - parsing, decoding, normalization, validation, verification, sanitization, policy enforcement

4. Runtime component and threat-model boundaries

   Split components with different execution contexts, privileges, deployment modes, consumers, attacker models, or failure modes.

   Consider:

   - API server, worker, CLI, frontend, backend, core library, language binding, integration provider, platform adapter, deployment or infrastructure component
   - unauthenticated user-facing code, authenticated user actions, admin-only functionality, internal service-to-service code, sandboxed execution, plugin runtime, LLM agent/runtime, supply-chain or build logic, smart contract/on-chain execution

5. Core responsibility and directory fallback

   When stronger boundaries are not obvious, split by core responsibility observed from representative source content.

   If evidence is weak, use top-level runtime directories and record a short note that the boundary is path-derived.

Use a small, bounded module set.

Prefer a good-enough security-relevant split over an optimal architectural split.

If two splits are both reasonable, choose the one that better separates trust boundaries and sensitive responsibilities.

If still ambiguous, choose the simpler split.

Do not split modules by individual functions, speculative vulnerabilities, or extra exploration done only to perfect the boundary.

## Priority Policy

Assign numeric priority.

- `0`: externally reachable or security-critical module
- `1`: high-value module with indirect exposure
- `2`: normal runtime logic
- `3`: support, config, deployment, docs, tests, examples, generated code, or static assets

## Boundaries

Stay within the repository-stage contract.

Do not produce function inventories, vulnerability candidates, exploit hypotheses, detailed attack paths, call graphs, or data-flow summaries.

Do not run commands that install dependencies, build, test, fuzz, modify repository state, use external services, or perform web/network access.

Do not perform exhaustive source inspection or repeated exploratory analysis.

Do not optimize module boundaries after the first defensible assignment.

## Validation

Before finishing, validate that:

- all required artifacts exist
- all JSON artifacts are parseable
- artifacts conform to the injected schemas
- module IDs are unique
- module artifact filenames match module IDs
- the output manifest contains artifact paths only

If validation fails, fix the artifacts once.

If uncertainty remains, record it in notes and finish.
