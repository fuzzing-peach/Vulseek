---
name: scan-function
description: Inspect one function and collect concrete vulnerability candidates with recall-first semantic reasoning.
---

# Scan Function

## Purpose

Inspect one function task using repository-level and module-level context.

This stage collects possible vulnerability candidates.

A candidate is not a confirmed vulnerability. It is a concrete suspicious site that should be reviewed, analyzed, fuzzed, or verified later.

This stage should not prove exploitability, perform full taint analysis, perform whole-program static analysis, or confirm vulnerabilities.

The goal is to collect concrete candidate locations according to semantic reasoning and the selection policy.

## Inputs

Use the paths, runtime metadata, and Zod schemas provided by the stage prompt.

Expected inputs include:

- repository-level artifact
- module-level artifact
- one function task
- checked-out repository
- output path or manifest path

## Outputs

Write the structured result required by the stage prompt.

Use the injected Zod schemas as the source of truth.

Always make an explicit candidate decision:

- return one or more candidates when suspicious sites are found
- return an empty candidate list when no candidate is found

## Lookup Policy

Use tools only to inspect the assigned function and nearby context.

Prefer Serena for:

- function body lookup
- nearby symbols
- direct callers or callees
- sibling functions
- local helpers

Use `rg`, `sed`, `awk`, `find`, or `semgrep` only as lightweight support.

Do not run CodeQL, whole-program static analysis, fuzzing, builds, tests, package managers, or external-network commands unless the stage prompt explicitly allows it.

## Inspection Scope

Inspect the assigned function first.

Then inspect only immediate context needed to understand why a site may be a candidate:

- direct caller or callee
- sibling function
- local helper
- nearby validator or sanitizer
- nearby policy check
- relevant type definition
- nearby constants or configuration
- nearby framework binding or routing metadata

Stay close to the assigned function.

Do not rebuild the call graph.

Do not trace full data flow.

Do not rescan the module or repository.

## Semantic Reasoning Policy

Use the selection policy as guidance, not as a rigid checklist.

Reason about the function's actual semantics:

- purpose and responsibility
- inputs, state, and assumptions
- security or correctness invariants
- data transformations before sensitive use
- checks, sanitizers, validators, and policy gates
- error handling and fail-open or fail-closed behavior
- interactions with nearby helpers or sibling functions
- fit with the module's threat model

Prefer candidates supported by semantic understanding of the code, not just keyword or pattern matches.

Do not emit a candidate only because the function contains a suspicious API call, parser, branch, or security-related keyword.

A candidate should explain why the local behavior may be security-relevant in context.

It is acceptable to infer a possible vulnerability shape from code semantics, but do not claim it is confirmed.

## Recall-First Rule

This stage favors coverage over precision.

Emit a suspicious site as a candidate when it may plausibly contain or influence a vulnerability according to local code semantics and the selection policy.

Do not require proof that the candidate is real.

Do not require confirmed exploitability.

Do not require complete source-to-sink reachability.

Do not require full taint analysis.

Only exclude a suspicious site when local evidence clearly shows that it is not a candidate.

Examples of clear exclusion evidence:

- the relevant value is constant and not attacker-influenced
- the sensitive operation is unreachable in this function's runtime context
- validation is complete, local, and directly protects the exact value used
- the operation is on a fixed internal resource with no security impact
- the code is test-only, dead, generated, or explicitly out of scope
- the suspicious pattern appears only in comments or unreachable fallback code

When uncertain, include the site as a candidate and lower its score or confidence.

## Candidate Selection Policy

Emit a candidate when semantic inspection identifies a concrete suspicious site inside or immediately around the assigned function.

The categories below are selection lenses, not strict rules.

Use them to guide reasoning, but base candidate selection on what the function actually does and how it behaves in context.

### 1. Dangerous sink usage

Select when the function reaches, wraps, dispatches to, or prepares data for a sensitive operation.

Consider:

- command execution
- filesystem read/write/delete
- path resolution
- network requests
- database queries or writes
- dynamic evaluation
- template rendering
- deserialization
- cryptographic operations
- authorization decisions
- privileged state mutation
- plugin or tool execution
- memory copy, allocation, pointer arithmetic, indexing, or bounds-sensitive operation

Do not prove full source-to-sink reachability.

It is enough to record that the sink appears security-relevant and may be influenced by function inputs, state, configuration, or nearby data flow.

### 2. Weak validation, sanitization, or canonicalization

Select when the function appears to validate, sanitize, normalize, or transform data in a way that may be incomplete or fragile.

Consider:

- validation after use
- validation of a different value than the one used later
- allowlist or denylist mismatch
- incomplete escaping or encoding
- missing canonicalization before path or URL use
- validation before decoding or normalization
- inconsistent validation compared with nearby sibling functions
- type check without semantic validation
- length, bounds, range, or format checks with edge cases

### 3. Authorization, authentication, or policy decision risk

Select when the function makes, bypasses, weakens, or depends on a security decision.

Consider:

- missing or unclear authorization before privileged behavior
- session, token, certificate, or signature accepted broadly
- role, tenant, owner, or object-level checks that look incomplete
- fail-open behavior
- policy check applied to the wrong subject, resource, tenant, or action
- inconsistent checks compared with sibling functions
- security decision split across helpers with unclear invariant

### 4. Parser, decoder, deserializer, or state-machine risk

Select when the function processes structured, malformed, adversarial, or boundary-sensitive input.

Consider:

- parser state transitions
- length or offset arithmetic
- nested structures
- recursive parsing
- partial parsing
- duplicate fields
- mixed encodings
- ambiguous normalization
- unchecked type conversions
- integer narrowing or overflow
- malformed input recovery
- decoder or decompressor behavior
- deserialization hooks
- resource exhaustion opportunities

### 5. Resource lifecycle or cleanup risk

Select when the function manages resources whose lifecycle may affect security or stability.

Consider:

- missing cleanup on error paths
- stale handle reuse
- file descriptor or socket leaks
- lock release issues
- transaction rollback issues
- temporary file misuse
- unsafe deletion
- object lifetime mismatch
- reference count imbalance
- partial initialization followed by use

### 6. Concurrency, callback, or reentrancy risk

Select when the function crosses async, callback, lock, transaction, retry, cancellation, or reentrant boundaries.

Consider:

- check-then-use patterns
- TOCTOU risks
- shared mutable state
- callbacks invoked during sensitive state
- async state changes after validation
- transaction boundary confusion
- queue ordering assumptions
- cancellation or retry inconsistencies

### 7. Cryptography, signature, certificate, or key handling risk

Select when the function verifies, generates, stores, transforms, or relies on cryptographic material.

Consider:

- weak or incomplete verification
- missing algorithm, mode, curve, chain, hostname, or replay checks
- signature verification over ambiguous or transformed bytes
- nonce, IV, salt, randomness, or key reuse issues
- secret exposure
- timing-sensitive comparison
- downgrade or insecure fallback behavior

### 8. Business logic or invariant risk

Select when the function enforces or mutates security-relevant application state.

Consider:

- ownership, tenant, role, quota, balance, or workflow invariants
- payment or billing state transitions
- admin/user boundary confusion
- replay or duplicate submission
- idempotency gaps
- stale state use
- trust in client-provided state
- backend enforcement missing for frontend assumptions

### 9. Plugin, tool, sandbox, or LLM-agent risk

Select when the function executes, dispatches, authorizes, or mediates extensible behavior.

Consider:

- plugin permission bypass
- unsafe tool invocation
- prompt/tool boundary confusion
- LLM output used as trusted instruction
- data exfiltration through tools
- sandbox escape surface
- untrusted code execution
- extension loading or path resolution
- capability leakage
- missing per-tool authorization

### 10. Sibling inconsistency

Select when nearby or similar functions apply a check or invariant that this function omits, weakens, or applies differently.

Consider:

- sibling validates but this function does not
- sibling canonicalizes before use but this function does not
- sibling authorizes before action but this function does not
- sibling handles error paths safely but this function proceeds
- equivalent sink usage is protected differently

## Candidate Quality Bar

Every emitted candidate must be concrete enough for a downstream verifier to inspect.

A candidate should be:

- tied to a file and line when possible
- tied to the assigned function or immediate context
- connected to a suspicious sink, weak check, validation issue, policy decision, parser behavior, lifecycle invariant, concurrency edge, semantic inconsistency, or other vulnerability-prone behavior
- supported by local code evidence or semantic reasoning

The candidate does not need to be proven.

The candidate does not need complete reachability proof.

The candidate does not need full source-to-sink analysis.

If the code site is plausibly security-relevant and cannot be locally ruled out, emit it.

Use lower confidence or lower score for weak, indirect, or speculative candidates.

Do not emit broad module-level observations.

Do not emit a candidate only because the function is large or complex.

## Candidate Reasoning

For each candidate, explain:

- the suspicious site
- the possible vulnerability shape
- the local evidence
- the relevant sink, check, invariant, or behavior
- what would need to be verified later

Use cautious language:

- "possible candidate because..."
- "may be vulnerable if..."
- "appears to..."
- "worth later verification because..."
- "should be checked for..."

Avoid confirmed-vulnerability language:

- "is vulnerable"
- "confirmed"
- "exploitable"
- "allows attackers to..."
- "root cause is proven"

## Scoring Policy

Assign score and confidence according to the runtime schema.

Score should reflect how promising and locally supported the candidate is, not confirmed severity.

High score:

- concrete suspicious site
- clear sensitive sink or invariant
- plausible attacker influence
- weak or missing local protection
- strong fit with the module threat model
- sibling inconsistency supports the concern

Medium score:

- concrete site
- security relevance is plausible
- some protection may exist but appears incomplete, indirect, or hard to evaluate locally
- reachability or attacker influence needs later confirmation

Low score:

- weak but plausible security relevance
- indirect influence
- local evidence is limited
- later verification is needed to determine whether it matters

Do not discard low-confidence candidates solely because they are uncertain.

Discard only when local evidence clearly rules them out.

## Fuzzing and Manual Analysis

Mark fuzzing as needed when dynamic exploration may help later, especially for:

- parsers
- decoders
- state machines
- protocol logic
- complex normalization
- memory safety
- resource lifecycle behavior
- concurrency timing
- input-dependent resource usage

Mark manual analysis as needed when later verification requires:

- cross-file reasoning
- framework behavior
- subtle authorization logic
- ambiguous invariants
- business logic interpretation
- source-to-sink confirmation

## Boundaries

Stay within the function-stage candidate collection contract.

This stage collects final candidate records, not confirmed vulnerability reports.

This stage is recall-oriented. When unsure, include the candidate with lower confidence instead of silently discarding it.

Do not perform full taint analysis.

Do not perform whole-program static analysis.

Do not run CodeQL unless the stage prompt explicitly requests it.

Do not rescan the module or repository.

Do not emit function inventories.

Do not produce exploit steps.

Do not run build, test, fuzzing, package-manager, or external-network work.

If no concrete candidate meets the quality bar, return an empty candidate list.

## Validation

Before finishing, validate that:

- the output artifact exists
- the output is parseable JSON
- the output conforms to the injected schema
- every emitted candidate is concrete
- every emitted candidate is tied to local code evidence or semantic reasoning
- empty results are represented according to the schema

If validation fails, fix the artifact once.
