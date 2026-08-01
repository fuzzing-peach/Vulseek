# Research Finding Artifacts Design

## Goal

Change Vulnerability Discovery from embedding or stringifying Findings inside
`discovery-report.json` to writing one strict JSON artifact per Finding. Keep
the Discovery Report as the track-level analysis document and use the Research
Registry as the durable source for downstream Finding state.

## Artifact Contract

`DiscoveryReport.findings` is replaced by `DiscoveryReport.findingPaths`.
Each item is a `$pathOf: "#/schemas/Finding"` value such as
`/task/findings/<finding-id>.json`. The referenced file contains exactly one
strict Finding object. `DiscoveryManifest.discoveryReportPath` remains a
`$pathOf: "#/schemas/DiscoveryReport"`.

The artifact contract must recursively validate `$pathOf` annotations found
inside another artifact. A Discovery task cannot complete if the report,
Finding path, or Finding content is invalid.

## Registry Flow

`record-discovery` reads `discoveryReportPath`, resolves every `findingPaths`
entry relative to the producing task, validates the loaded object, and persists
one row per Finding in `research_findings`. Paths are provenance artifacts and
are not stored in the Finding row. The transaction remains atomic.

Track Review receives the copied Discovery Report for track-level context and
uses the `research-db` skill to load persisted Findings. It must not dereference
the producing task's `/task/findings` paths from its own task directory.

## Prompt Contract

Vulnerability Discovery writes Findings under `/task/findings/`, validates
each file, then writes `discovery-report.json` with `findingPaths`. It must not
embed Finding objects or JSON-encoded Finding strings in the report.

## Compatibility

This is a forward-only Research pipeline contract change. No fallback reads
legacy inline `findings`, and no database migration is required. Existing Job
snapshots keep their prior schema; new Research Jobs receive the new contract.

## Verification

Tests cover nested artifact path-list normalization and validation, multiple
Finding files, missing and invalid files, empty lists, Registry persistence,
and rejection of legacy inline Findings. Type checks and repository diff checks
must pass.
