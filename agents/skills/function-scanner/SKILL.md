---
name: function-scanner
description: Scan one function using repository-level and module-level context. Identify concrete candidate sites inside or immediately around the function, score them, and write them to a local JSON result file.
---

# Function Scanner

Use this skill when Dokploy starts a function-level scanner for one function task inside a full-scan job.

This is the only full-scan layer that writes final candidates.

## Inputs

You should be given:

- repository-level scan artifacts
- module-level scan artifacts
- one function task
- the checked out repository
- the required output path for `function_result.json`
- an optional output path for a local markdown note

## High-Level Objective

Inspect one function and decide whether it contains one or more concrete candidate locations that deserve deeper analysis.

You are not required to prove a vulnerability.

You are required to produce concrete candidate sites and a score.

## Lookup Priority

For code lookup, function body lookup, sibling-function comparison, caller lookup, and related-symbol navigation:

1. prefer Serena first
2. use repository-level and module-level artifacts as context
3. use `rg`, `sed`, `awk`, `find`, or `semgrep` only as fallback or lightweight support

Do not rely on grep-only lookup when Serena can provide the relevant symbol or reference information.

## What To Look For

- externally influenced input handling
- boundary checks
- integer narrowing or overflow edges
- parser state transitions
- auth / policy / certificate / signature decisions
- resource lifecycle mistakes
- callback and concurrency hazards
- dangerous sink usage
- missing validation relative to module expectations
- inconsistencies with sibling functions

## Candidate Rule

If you identify a plausible candidate:

- give it a concrete title
- name the exact file and line
- explain the local reason briefly
- assign a confidence score
- write it into the required result JSON file

Do not collapse everything into vague module-level prose.

## Candidate Fields

Each candidate should include:

- `title`
- `description`
- `filePath`
- `line`
- `confidence`
- `score`

## Required Result JSON

If the runtime asks you to write a result JSON file such as `function_result.json`, use this fixed structure:

```json
{
  "candidates": [
    {
      "title": "Handshake state transition may bypass required validation",
      "description": "A state-changing path appears reachable before the expected validation gate completes.",
      "filePath": "src/tls13.c",
      "line": 447,
      "confidence": 0.81,
      "score": 6.4
    }
  ]
}
```

Rules:

- output exactly one top-level object
- always include `candidates`
- use `[]` when there are no candidates
- each candidate may contain only `title`, `description`, `filePath`, `line`, `confidence`, and `score`
- write the file atomically when possible: write a temp file first, then rename it into place
- do not emit any structured stdout protocol

## Working Style

- inspect the function and its immediate local context first
- prefer Serena for symbol-aware lookup of the function, sibling functions, callers, and nearby helpers
- use repository/module artifacts to understand why the function matters
- use raw text tools only when Serena is unavailable or when broad text search is specifically needed
- keep recall high, but do not emit shapeless noise
- prefer multiple concrete candidates over one vague summary

## Final Rule

This layer is responsible for writing the final candidate list into the required JSON result file.
