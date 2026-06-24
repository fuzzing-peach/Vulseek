---
name: identify-target
description: Identify high-value vulnerability scanning targets from a module and its attack-surface model.
---

# Identify Target

## Purpose

Turn a module threat model into concrete scan targets. A target is the smallest useful unit for vulnerability mining; it is not necessarily a function.

This is a routing stage. It should produce target artifacts, not vulnerability candidates.

## Target Types

Use the target kind that best matches source evidence:

- `function`
- `route-handler`
- `middleware`
- `api-route`
- `server-action`
- `page-loader`
- `controller-action`
- `view-function`
- `resolver`
- `job-handler`
- `cli-command`
- `security-config`
- `template-render`
- `parser-deserializer`
- `data-access`
- `unknown`

## Workflow

1. Read repository, module, and threat model JSON.
2. Inspect module files and framework manifests/config.
3. Locate entrypoints and security-boundary code first.
4. Identify targets that are reachable, security-sensitive, or useful for source-to-sink review.
5. Exclude low-value files: tests, fixtures, generated code, docs, vendored code, ordinary lockfiles, boilerplate config without runtime security effect.
6. Write one target JSON artifact per target under `/task/targets`.
7. Return the path manifest required by the prompt.

## Selection Policy

Prefer targets with one or more of:

- attacker-controlled inputs
- auth/session/authorization decisions
- tenant, owner, role, quota, workflow, or object-level checks
- database, command, filesystem, network, template, deserialization, crypto, parser, memory, or resource sinks
- framework entrypoint semantics, such as route handler, middleware, resolver, controller action, server action, worker job, or CLI command
- security configuration that changes runtime trust, CORS, cookies, sessions, headers, CSRF, auth, secrets, or sandbox/tool permissions

Do not enumerate every helper when a route/controller/resolver target gives a better review unit.
For native modules, functions can still be the right target.

## Boundaries

Do not emit candidates or final vulnerability claims.
Do not run builds, tests, package managers, fuzzers, network commands, or external lookups.

## Validation

Before finishing, ensure each target artifact and the returned manifest validate against the injected schemas.
