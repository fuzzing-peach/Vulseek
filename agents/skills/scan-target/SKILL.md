---
name: scan-target
description: Inspect one generic vulnerability-mining target and emit concrete candidate findings for later analysis.
---

# Scan Target

## Purpose

Inspect one assigned target for **one assigned vulnerability class** (`vulnerability_class_focus` from the stage prompt) and collect possible vulnerability candidates of that class only.

A candidate is not a confirmed vulnerability. It is a concrete suspicious source, check, sink, or boundary that deserves deeper analysis.

## Workflow

1. Read repository, module, threat model, and target JSON.
2. Inspect the target source and immediate framework/runtime context.
3. Reconstruct attacker inputs and sensitive sinks relevant to `vulnerability_class_focus`.
4. Look for missing, weak, misplaced, or inconsistent checks for that class only.
5. Emit candidate artifacts for plausible findings of that class.
6. Return an empty candidate manifest when no candidate is found.

## Focused Vulnerability Lens

Stay on `vulnerability_class_focus`. Use target kind and threat model only as context for that class. Do not broaden into unrelated classes in this task.

## Candidate Standard

Emit a candidate only when there is concrete source-backed suspicion for the focus class. Explain:

- attacker input or trust boundary
- missing or weak check
- affected sink or security decision
- relevant file and line when available
- why deeper analysis is needed

Set `candidate.vulnerabilityType` to `vulnerability_class_focus`.

Do not emit candidates from generic keywords alone.
Do not claim final exploitability.

## Boundaries

Stay near the assigned target. Inspect direct helpers, route registration, middleware, model/policy checks, config, and nearby sinks as needed, but do not rescan the whole repository.

Do not run builds, tests, package managers, fuzzers, network commands, or external lookups.

## Validation

Before finishing, ensure candidate artifacts and the returned manifest validate against the injected schemas.
