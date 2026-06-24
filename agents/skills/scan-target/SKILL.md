---
name: scan-target
description: Inspect one generic vulnerability-mining target and emit concrete candidate findings for later analysis.
---

# Scan Target

## Purpose

Inspect one assigned target and collect possible vulnerability candidates.

A candidate is not a confirmed vulnerability. It is a concrete suspicious source, check, sink, or boundary that deserves deeper analysis.

## Workflow

1. Read repository, module, threat model, and target JSON.
2. Inspect the target source and immediate framework/runtime context.
3. Reconstruct attacker inputs and sensitive sinks relevant to this target.
4. Look for missing, weak, misplaced, or inconsistent checks.
5. Emit candidate artifacts for plausible findings.
6. Return an empty candidate manifest when no candidate is found.

## Web And Generic Vulnerability Lenses

Use the target kind and threat model to choose relevant checks:

- auth bypass, missing authorization, IDOR/BOLA
- SQL, NoSQL, command, template, path, LDAP, or expression injection
- SSRF and open redirect
- file upload, arbitrary file read/write/delete, unsafe static serving
- XSS, unsafe template rendering, escaping mismatch
- CSRF, session, cookie, CORS, security header, and auth configuration risk
- deserialization, parser, decoder, or resource exhaustion risk
- secret exposure, unsafe default, plugin/tool/sandbox/LLM boundary risk
- C/C++ memory safety, protocol state, crypto, lifecycle, callback, and resource risks

## Candidate Standard

Emit a candidate only when there is concrete source-backed suspicion. Explain:

- attacker input or trust boundary
- missing or weak check
- affected sink or security decision
- relevant file and line when available
- why deeper analysis is needed

Do not emit candidates from generic keywords alone.
Do not claim final exploitability.

## Boundaries

Stay near the assigned target. Inspect direct helpers, route registration, middleware, model/policy checks, config, and nearby sinks as needed, but do not rescan the whole repository.

Do not run builds, tests, package managers, fuzzers, network commands, or external lookups.

## Validation

Before finishing, ensure candidate artifacts and the returned manifest validate against the injected schemas.
