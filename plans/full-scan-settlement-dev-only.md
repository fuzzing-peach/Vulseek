# Full Scan Task-Graph Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make Full Scan completion depend on a durable task-graph fixpoint, with explicit finalization and partial-completion status, while keeping all development and validation strictly inside dev.

**Architecture:** Each terminal task records whether its downstream expansion is pending, in progress, or complete. Downstream task creation is idempotent through a stable dispatch key, and database task rows remain the source of truth while BullMQ remains a recoverable delivery mechanism. A job enters finalizing only after the graph is stable, then becomes finished, partially_finished, or failed after cleanup.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL migrations, BullMQ, Vulseek tRPC, React/Next.js, Vitest, Biome, pnpm.

## Global Constraints

- All code changes, migrations, builds, browser checks, database checks, and end-to-end scans run only against dev at http://127.0.0.1:23000.
- Do not access, stop, restart, migrate, inspect, deploy, or modify release containers, release PostgreSQL, release Redis, release volumes, release networks, release images, or release jobs.
- Do not create a release tag or push a release image as part of this work.
- The dev test project using https://github.com/mrvladus/xml.h.git is retained after validation.
- Canonical stage names are the only supported stage names; the old module/function task-count concept is removed.
- Candidate projection is a query read model and is not an orchestration completion signal.

---

### Task 1: Define terminal status policy

**Files:**
- Modify: packages/server/src/services/scan/state/scan-state-machine.ts
- Create: packages/server/src/services/scan/state/scan-job-settlement.test.ts
- Modify: packages/server/src/db/schema/scan.ts

**Interfaces:**
- Produces a pure terminal-status helper:

    export const resolveTerminalScanJobStatus: (input: {
      rootFailed: boolean;
      failedTaskCount: number;
      canceled: boolean;
    }) => "finished" | "partially_finished" | "failed" | "canceled";

- [ ] Write tests for no failures, non-root failures, root failures, cancellation, and terminal/non-terminal task statuses.
- [ ] Run: pnpm exec vitest run packages/server/src/services/scan/state/scan-job-settlement.test.ts. Verify the new tests fail.
- [ ] Add finalizing and partially_finished to scan job status types and implement the pure helper. Keep database access out of this helper.
- [ ] Run the focused test again and verify it passes.
- [ ] Commit: git commit -m "feat(scan): define full scan terminal states".

### Task 2: Add settlement migration and delete legacy counters

**Files:**
- Create: apps/vulseek/drizzle/0212_scan_job_settlement.sql
- Modify: apps/vulseek/drizzle/meta/_journal.json
- Modify: packages/server/src/db/schema/scan.ts
- Modify: packages/server/src/services/scan/persistence/scan-job.repo.ts
- Modify: packages/server/src/services/scan/api/scan-jobs.ts
- Modify: packages/server/src/services/scan/retry-failed-tasks.ts
- Modify: packages/server/src/services/scan/pipeline/recover-full-scan-queues.pipeline.ts
- Modify: related scan test fixtures

**Interfaces:**
- Adds task fields downstreamDispatchStatus, downstreamRouteKey, downstreamDispatchedAt, and dispatchKey.
- Adds dispatch states pending, dispatching, and completed.

- [ ] Add migration tests that assert the two new scan job statuses, the dispatch states, and absence of the six legacy module/function counter columns.
- [ ] Create migration 0212. Add enum values and task dispatch columns, backfill existing terminal tasks as completed, backfill other tasks as pending, set the pending default, drop the six legacy columns, and add a partial unique index for non-null dispatchKey.
- [ ] Remove the six fields from Drizzle schema, scan job selections, API return types, fixtures, retry code, and queue recovery contracts.
- [ ] Delete recalculateScanTaskCountsRepo and all wrappers and calls.
- [ ] Run the migration against a temporary dev-only PostgreSQL database and verify the schema.
- [ ] Run pnpm typecheck and commit: git commit -m "feat(scan): persist task graph settlement state".

### Task 3: Make downstream expansion durable and idempotent

**Files:**
- Modify: packages/server/src/services/scan/persistence/task.repo.ts
- Modify: packages/server/src/services/scan/pipeline/pipeline-runner.ts
- Modify: packages/server/src/services/scan.ts
- Create: packages/server/src/services/scan/pipeline/pipeline-runner.settlement.test.ts

**Interfaces:**
- Add claimPendingDownstreamDispatch(taskId): Promise<boolean>.
- Add completeDownstreamDispatch(taskId): Promise<void>.
- Add resetStaleDownstreamDispatches(scanJobId): Promise<number>.
- Make child creation idempotent by dispatchKey.

- [ ] Write tests for repeated dispatch, zero downstream inputs, child creation before enqueue, stale dispatching recovery, and failed/exited/canceled parents.
- [ ] Implement compare-and-set transitions pending to dispatching to completed. On deterministic expansion failure, record task failure and close the branch.
- [ ] Generate a stable dispatch key from scan job, parent task, edge name, and fan-out item index. Use a deterministic child task ID and reuse an existing child with the same key.
- [ ] Refactor every full-scan edge in buildFullScanPipeline to pass edge name and item index. Cover repository-to-attack-surface, attack-surface-to-identify, identify-to-scan, scan-to-analyze, analyze-to-critique, analyze-to-verify, verify-to-triage, and critique-to-analyze.
- [ ] Persist the selected route key before task completion. Mark dispatch complete after child rows are durable; enqueue children afterward so pending DB rows recover missing queue entries.
- [ ] Reset stale dispatching rows during dev startup recovery and run the focused pipeline tests.
- [ ] Commit: git commit -m "feat(scan): make downstream task expansion recoverable".

### Task 4: Replace refresh/reconcile with graph settlement

**Files:**
- Modify: packages/server/src/services/scan/pipeline/pipeline-runner.ts
- Modify: packages/server/src/services/scan.ts
- Modify: packages/server/src/services/scan/state/scan-state-machine.ts
- Create: packages/server/src/services/scan/pipeline/job-settlement.test.ts

**Interfaces:**
- Add trySettleScanJob(scanJobId): Promise<"not_ready" | "finalizing" | "terminal">.
- Add finalizeScanJob(scanJobId): Promise<void>.
- Return only rootTerminal, rootFailed, openTaskCount, unsettledDispatchCount, and failedNonRootTaskCount from the aggregate settlement query.

- [ ] Write tests proving that open tasks, unfinished dispatch, non-terminal root, or an active dispatch prevents settlement.
- [ ] Implement one aggregate settlement query. Do not load candidates, artifacts, task input/output, descendant tasks, or global BullMQ counts.
- [ ] Run settlement once after each job-loop inspection/dispatch batch, rather than after every task.
- [ ] Delete refreshPipelineState, schedulePipelineStateRefresh, reconcileScanJobCandidatePipelineStatus, getPendingAnalysisCandidates, getPendingVerificationCandidates, and all per-task refresh calls.
- [ ] Lock the scan job row when entering finalizing. Prevent new launches and reruns while finalizing.
- [ ] Clean only the job-owned queue entries, containers, lanes, stage groups, and runtime supervisor state.
- [ ] Recheck task and dispatch counts after cleanup. Set finished, partially_finished, or failed using the pure policy helper; retain finalizing and retry on cleanup failure.
- [ ] Run focused settlement tests and commit: git commit -m "feat(scan): settle full scans from task graph".

### Task 5: Add lightweight Candidates authorization

**Files:**
- Create: packages/server/src/services/scan/persistence/scan-job-access.repo.ts
- Modify: apps/vulseek/server/api/routers/scan.ts
- Create: packages/server/src/services/scan/persistence/scan-job-access.repo.test.ts

**Interfaces:**

    authorizeScanJobAccess(scanJobId: string, organizationId: string): Promise<void>

- [ ] Test application jobs, compose jobs, missing jobs, invalid targets, matching organizations, and cross-organization access. Assert that this path does not query tasks or call computeTaskCost.
- [ ] Implement one SQL query joining scan job, application/compose, environment, and project, returning only the resolved organization.
- [ ] Replace full findScanJobById authorization in scan.candidates and reuse the helper in candidate detail, files, and rerun endpoints that only need access control.
- [ ] Run the focused authorization test and commit: git commit -m "perf(scan): use lightweight job access authorization".

### Task 6: Update API and frontend status handling

**Files:**
- Modify: apps/vulseek/server/api/routers/scan.ts
- Modify: apps/vulseek/components/dashboard/scanning/show-scan-job-detail.tsx
- Modify: Vulseek home/job status components that enumerate scan job statuses
- Test: relevant Vulseek scan detail and status tests

- [ ] Add failing tests for finalizing polling and partially_finished terminal behavior.
- [ ] Add both statuses to API types, frontend unions, filters, badges, and terminal predicates.
- [ ] Display finalizing while continuing refresh; display partially_finished with failed task count and stop terminal polling.
- [ ] Run pnpm exec vitest run apps/vulseek and commit: git commit -m "feat(ui): show full scan finalization states".

### Task 7: Run the retained dev end-to-end scan

**Files:**
- Modify only dev environment data and the retained test project.
- Evidence: dev logs, dev PostgreSQL rows, dev Redis queue inspection, and browser screenshots.

- [ ] Verify the target URL is http://127.0.0.1:23000 and all database, Redis, network, volume, and image references are dev-scoped.
- [ ] Create and retain project xml.h Full Scan Settlement from https://github.com/mrvladus/xml.h.git on branch main.
- [ ] Create its dev application/profile with the dev default enabled agent profile.
- [ ] Build the dev checkout image and verify checkout succeeds.
- [ ] Start Full Scan and record the job ID.
- [ ] During execution verify parent-child fan-out, unique dispatch keys, dispatch recovery, and absence of candidate/artifact traversal in settlement.
- [ ] Verify the normal state sequence pending/running to finalizing to finished. If a genuine non-root task fails, verify partially_finished and inspect the failure.
- [ ] Verify open tasks, unsettled dispatches, job-owned queue entries, containers, lanes, and runtime supervisor entries are zero after terminal status.
- [ ] Verify browser polling stops after finished or partially_finished.
- [ ] Leave the project and checkout image in dev for future regression tests.

### Task 8: Run final dev-only verification

- [ ] Run pnpm test, pnpm typecheck, and pnpm check against the workspace without touching release.
- [ ] Run the dev-scoped server and Vulseek builds without deploying or restarting release.
- [ ] Inspect the worktree for only intended code, migration, test, and dev data changes.
- [ ] Record migration results, test output, dev Full Scan job ID, final status, dispatch uniqueness, cleanup counts, and browser polling behavior.
