---
name: attack-surface-model
description: Build a module-level attack surface and threat model for generic vulnerability mining across web, service, worker, CLI, config, parser, and native-code modules.
---

# Attack Surface Model

## Purpose

Model one repository module as an attack surface. This is not a finding stage.

The output should explain where untrusted input enters, which boundaries it crosses, what assets and sinks matter, and which vulnerability classes should drive target identification.

## Inputs

Read the repository and module JSON paths from the stage prompt before inspecting source.

Expected inputs:

- repository artifact
- module artifact
- checked-out source tree
- runtime output schema

## Workflow

1. Read repository and module artifacts.
2. Inspect the module files listed in the module artifact.
3. Identify runtime context and framework conventions.
4. Identify entrypoints, attacker inputs, trust boundaries, sensitive assets, and sink classes.
5. Record assumptions and limitations when source evidence is incomplete.
6. Write `/task/outputs/module-threat-model.json`.
7. Return the manifest required by the prompt.

## Modeling Guidance

Do not assume C/C++ or function-centric code. Fit the module:

- Web apps: routes, middleware, controllers, API routes, server actions, resolvers, views, session/auth/CORS/security config.
- Services and workers: queue handlers, scheduled jobs, webhook handlers, RPC handlers, background processors.
- Data and rendering: database boundaries, ORM calls, template rendering, serialization, file upload/download/static serving.
- Native code: parser entrypoints, protocol state, memory/resource lifecycle, crypto, FFI, bindings.
- Operational code: CLI commands, deployment/security config, package scripts, plugin/tool execution.

Prefer source-backed facts over generic lists. Keep the model compact but useful for target identification.

## Boundaries

Do not emit vulnerability candidates, rule plans, exploit claims, or final findings.
Do not run builds, tests, package managers, fuzzers, network commands, or external lookups.

## Validation

Before finishing, ensure the threat model JSON and returned manifest validate against the injected schemas.
