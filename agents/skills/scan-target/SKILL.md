---
name: scan-target
description: Inspect one generic vulnerability-mining target and emit concrete candidate findings for later analysis.
---

# Scan Target

## Purpose

Inspect one assigned target and collect concrete vulnerability candidates across all applicable security classes.

A candidate is not a confirmed vulnerability. It is a concrete suspicious source, check, sink, or boundary that deserves deeper analysis.

## Workflow

1. Read repository, module, threat model, and target JSON.
2. Inspect the target source and immediate framework/runtime context.
3. Reconstruct attacker inputs, trust boundaries, and sensitive sinks.
4. Look for missing, weak, misplaced, or inconsistent security checks across applicable classes.
5. Emit candidate artifacts for distinct plausible findings, assigning each its evidence-backed vulnerability type.
6. Return an empty candidate manifest when no candidate is found.

## Vulnerability Lens

Use the target kind, module, threat model, attacker inputs, and sinks to determine which vulnerability classes apply. Do not invent findings from generic keywords, and keep each candidate tied to a distinct root cause.

## Candidate Standard

Emit a candidate only when there is concrete source-backed suspicion. Explain:

- attacker input or trust boundary
- missing or weak check
- affected sink or security decision
- relevant file and line when available
- why deeper analysis is needed

Set `candidate.vulnerabilityType` to the concrete vulnerability class supported by the evidence.

Do not emit candidates from generic keywords alone.
Do not claim final exploitability.

## Boundaries

Stay near the assigned target. Inspect direct helpers, route registration, middleware, model/policy checks, config, and nearby sinks as needed, but do not rescan the whole repository.

Do not run builds, tests, package managers, fuzzers, network commands, or external lookups.

## Validation

Before finishing, ensure candidate artifacts and the returned manifest validate against the injected schemas.
