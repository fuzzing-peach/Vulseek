# Research Running Tasks Design

## Goal

Show active Research Pipeline tasks in the existing Job detail Running Tasks table without changing the API shape or the established Full Scan and Delta Scan presentation.

## Design

Extend `RunningTaskStage` and `mapRunningTaskStage()` with all canonical Research Pipeline stage IDs:

- `research-scope`
- `surface-map`
- `track-plan`
- `vulnerability-discovery`
- `track-review`
- `finding-validation`
- `finding-review`
- `chain-synthesis`
- `chain-review`
- `exploit-validation`
- `exploit-review`
- `research-report`

The mapping remains an explicit allowlist. Unknown and legacy stage IDs continue to return `null` and remain absent from the Running Tasks view.

Existing Full Scan and Delta Scan title/subtitle derivation remains unchanged. Research task rows use the persisted task name as the title and the canonical stage display name as the subtitle. This avoids coupling the running-task query to stage-specific Research input schemas while keeping the stage understandable in the UI.

## Data Flow

`scan.jobRunningTasks` continues to read through `jobRuntimeStatusStore`, `findScanJobRunningTasks()`, and `listRunningTaskViewsByScanJobIdRepo()`. The repository maps each active task's `stageName`; Research stages now survive this mapping and are returned through the existing response type to the existing table.

No database, tRPC, cache, or component contract changes are required.

## Tests

- Verify every canonical Research stage maps to itself.
- Verify legacy and unknown stages remain rejected.
- Verify a Research task row uses its task name and stage display name.
- Run the focused Vitest tests, server typecheck, Vulseek typecheck, and `git diff --check`.
