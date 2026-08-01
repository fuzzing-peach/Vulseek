# Research Running Tasks Implementation Plan

**Goal:** Include active Research Pipeline tasks in the existing Job detail Running Tasks view.

**Architecture:** Keep the existing explicit running-stage allowlist and extend it with the canonical Research stage IDs. Preserve existing Full/Delta title derivation and use task name plus stage display name for Research rows.

**Tech Stack:** TypeScript, Vitest, Drizzle repository helpers, React/Next.js.

## Global Constraints

- Do not change the tRPC response shape, database schema, or runtime cache contract.
- Continue rejecting unknown and legacy stage IDs.
- Preserve existing Full Scan and Delta Scan rendering behavior.

### Task 1: Research Stage Mapping

**Files:**
- Modify: `packages/server/src/services/scan/running-task-stage.ts`
- Test: `apps/vulseek/__test__/server/running-task-stage.test.ts`

- [ ] Add assertions that all twelve canonical Research stage IDs map to themselves.
- [ ] Run the focused test and confirm the new assertions fail before implementation.
- [ ] Add the Research IDs to `RunningTaskStage` and `mapRunningTaskStage()`.
- [ ] Run the focused test and confirm it passes while legacy and unknown stages remain rejected.

### Task 2: Research Row Presentation

**Files:**
- Modify: `packages/server/src/services/scan/persistence/task.repo.ts`
- Test: `apps/vulseek/__test__/server/running-task-stage.test.ts`

- [ ] Add a small exported helper or repository-level testable branch for Research row presentation, asserting task name is the title and canonical stage display name is the subtitle.
- [ ] Run the focused test and confirm it fails before implementation.
- [ ] Use `getScanStageDisplayName(stageName)` for Research subtitles while leaving existing stage branches unchanged.
- [ ] Run server tests, both typechecks, and `git diff --check`.

### Task 3: Runtime Verification

**Files:**
- No additional source files.

- [ ] Query the active dev Research Job through `scan.jobRunningTasks` and verify the `research-scope` task is returned.
- [ ] Confirm the task remains visible while its status is active and no release service is contacted.
