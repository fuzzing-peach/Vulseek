# Task Driver Symlink Drain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a reused container switches `/task` only after the previous non-persistent driver has reliably written its exit marker and stopped, while keeping all driver-owned files under `/task`.

**Architecture:** Add a drain phase to the existing runtime handoff. The previous task remains the active `/task` target while the server waits for its driver lifecycle to reach `shell_exit`, its existing exit marker to be written, and its recorded PID to stop; only then are old runtime files reset and the symlink changed. Persistent drivers keep their current queue-based lifecycle and are never drained between tasks.

**Tech Stack:** TypeScript, Node.js filesystem/process APIs, Docker `exec`, Vitest, existing ACP driver shell protocol.

## Global Constraints

- Driver runtime files remain under `/task` and continue to be written through the current task alias.
- The existing exit marker remains `[acp-driver] exit_code=<number>`; do not add a new marker, output field, or generation value.
- Persistent drivers are not required to emit an exit marker between tasks.
- Do not change database schema, task status definitions, or release deployment configuration.
- Do not modify unrelated existing worktree changes.

---

### Task 1: Define the driver handoff contract and test fixtures

**Files:**
- Modify: `packages/server/src/services/scan/runtime/run-single-turn-agent.ts`
- Create or modify: `packages/server/src/services/scan/runtime/run-single-turn-agent.test.ts`

**Interfaces:**
- Add an internal handoff result type containing the observed PID, exit code, and lifecycle completion state.
- Add an internal `waitForPreviousDriverExit` helper that accepts `containerName`, `driverPidPath`, `driverLifecyclePath`, and `stderrPath`.
- Keep `updateTaskAliasSymlinkInContainer` as the only function that changes `/task`.

- [ ] **Step 1: Write failing tests for the handoff rules**

Cover these cases with mocked container command output:

```ts
it("waits for the previous driver exit marker before switching the alias", async () => {

});

it("does not treat a stale marker as proof that the current old driver has exited", async () => {

});

it("times out without switching the alias when the previous driver never exits", async () => {

});

it("does not wait for an exit marker for persistent driver queue reuse", async () => {

});
```

The tests should assert ordering: drain probe, runtime reset, then symlink update. They must not launch a new driver before the alias switch completes.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm exec vitest run packages/server/src/services/scan/runtime/run-single-turn-agent.test.ts
```

Expected: the new handoff tests fail because no drain helper or ordering contract exists yet.

- [ ] **Step 3: Define the existing-marker handoff protocol**

Do not change the driver output format. Before changing `/task`, use the existing driver runtime files while `/task` still points to the old task. Clear or truncate the old marker-bearing files only after the old driver has exited, so a new driver cannot inherit an ambiguous marker.

```text
[acp-driver] exit_code=0
[acp-driver-lifecycle] ... shell_exit status=0
```

The handoff is identified by the old task's current PID, lifecycle completion line, and marker observed before the symlink switch. No new output or marker is introduced.

- [ ] **Step 4: Implement `waitForPreviousDriverExit`**

Use a bounded polling loop implemented through `docker exec`:

1. Read the previous driver PID from `/task/acp-driver.pid`.
2. Read the exit marker and lifecycle log from `/task`.
3. Require the existing `exit_code` marker and `shell_exit` record.
4. Require the recorded PID to be absent or no longer running.
5. Return the exit code and diagnostics.

Use a short polling interval and an explicit timeout. On timeout, throw an error containing the container name, previous PID, last lifecycle line, and last stderr line. This prevents the new driver from inheriting an ambiguous `/task` directory.

- [ ] **Step 5: Run the focused tests and verify they pass**

Run:

```bash
pnpm exec vitest run packages/server/src/services/scan/runtime/run-single-turn-agent.test.ts
```

Expected: all handoff tests pass, including timeout and persistent-driver bypass cases.

### Task 2: Insert the drain before non-persistent `/task` replacement

**Files:**
- Modify: `packages/server/src/services/scan/runtime/run-single-turn-agent.ts`
- Test: `packages/server/src/services/scan/runtime/run-single-turn-agent.test.ts`

**Interfaces:**
- `startContainer` continues to prepare/reuse the container.
- `runSingleTurnAgentInContainer` continues to prepare runtime files and start the driver.
- New drain behavior is internal and does not alter stage APIs or prompt paths.

- [ ] **Step 1: Add the reuse decision tests**

Test that:

- reused non-persistent containers drain before `updateTaskAliasSymlinkInContainer`;
- newly created containers do not wait for a previous driver;
- persistent queue reuse does not drain or rotate `/task` per task;
- a drain timeout leaves the old alias intact and does not launch the new driver.

- [ ] **Step 2: Call the drain at the actual handoff point**

In the running-container branch of `startContainer`, perform the drain before `rm /task` and `ln -s ... /task`. Use the old driver paths while `/task` still points to the old task. Do not call the drain for `input.persistent === true`.

The sequence must be:

```text
inspect old driver
-> wait for matching exit marker and process termination
-> reset old driver marker/pid/lifecycle state
-> update /task symlink
-> initialize the new task runtime
```

Do not treat the marker alone as sufficient; the process termination check is required so the old shell cannot append another line after the alias changes.

- [ ] **Step 3: Make launch marker parsing handoff-aware**

Update the handoff and running-task inspection path so a marker is accepted only after the pre-switch drain has observed the old driver lifecycle completion and process termination. A marker found after the new symlink is active is not independently sufficient to prove that the new driver exited; it must be interpreted together with the current task runtime state.

The current failure messages remain unchanged for valid driver failures, including:

```text
ACP driver exited before reporting THREAD_ID
ACP driver exited with code <n> before reporting THREAD_ID
```

- [ ] **Step 4: Run runtime and pipeline regression tests**

Run:

```bash
pnpm exec vitest run \
  packages/server/src/services/scan/runtime/run-single-turn-agent.test.ts \
  packages/server/src/services/scan/pipeline/pipeline-runner.settlement.test.ts \
  packages/server/src/services/scan/retry-failed-tasks.test.ts
```

Expected: existing task lifecycle tests pass and no new task is failed by a stale previous-driver marker.

### Task 3: Preserve `/task` driver paths and harden cleanup

**Files:**
- Modify: `packages/server/src/services/scan/runtime/run-single-turn-agent.ts`
- Modify if required by the protocol: `packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs`
- Test: `packages/server/src/services/dockerfiles/vulseek-acp-driver.test.mjs`

**Interfaces:**
- Driver input continues to receive `/task` paths for `stderrPath`, `stdoutPath`, `statePath`, `usagePath`, `activityPath`, and structured output.
- Persistent queue entries continue to use the existing queue directory and are not affected by non-persistent drain.

- [ ] **Step 1: Verify the driver writes the marker after the node process exits**

Add or update a driver shell test asserting that the marker is appended after the driver process returns and that the lifecycle `shell_exit` record follows the same driver process.

- [ ] **Step 2: Reset only stale handoff files**

After a successful drain and before changing `/task`, remove or truncate only driver coordination files such as:

```text
/task/acp-driver.pid
/task/acp-driver-lifecycle.log
/task/acp-driver-stdout.log
/task/acp-driver-launch.sh
/task/acp-driver-input.json
```

Do not remove agent output, input artifacts, candidate files, or the old task directory itself.

- [ ] **Step 3: Verify persistent behavior remains unchanged**

Run the persistent-driver test suite and confirm queued tasks still reuse the live process without requiring `[acp-driver] exit_code` between requests.

### Task 4: End-to-end verification

**Files:**
- Modify only tests or diagnostic logging if verification exposes a defect.

- [ ] **Step 1: Run static validation**

```bash
pnpm --filter @vulseek/server typecheck
pnpm exec biome check packages/server/src/services/scan/runtime/run-single-turn-agent.ts packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs
git diff --check
```

Expected: typecheck, formatting checks, and whitespace checks pass.

- [ ] **Step 2: Run a dev-only reusable-container scan**

Use the existing dev environment and a small full scan. Confirm in task logs that each handoff follows:

```text
previous driver exit marker
previous driver process stopped
task alias switched
new driver launched
```

Confirm that no task reports `ACP driver exited before reporting THREAD_ID` because of a marker from the previous task.

- [ ] **Step 3: Test timeout safety**

Use a controlled stale-driver fixture to confirm a timeout fails the handoff before switching `/task` and before launching the next driver. The error must identify the previous PID and last lifecycle record.

- [ ] **Step 4: Check the final diff scope**

```bash
git status --short
git diff -- packages/server/src/services/scan/runtime/run-single-turn-agent.ts packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs packages/server/src/services/scan/runtime/run-single-turn-agent.test.ts packages/server/src/services/dockerfiles/vulseek-acp-driver.test.mjs
```

Expected: only the driver handoff implementation, its tests, and narrowly related diagnostics are included.

## Acceptance Criteria

- `/task` remains the write path used by the driver.
- A reused non-persistent container never switches `/task` while the previous driver can still write to it.
- Exit markers are observed before the symlink switch and cannot be confused with a new task's runtime state.
- A missing or delayed marker causes a bounded handoff failure, not an unsafe symlink switch.
- Persistent drivers continue to process multiple tasks without per-task exit-marker waits.
- Existing task completion and failure semantics remain unchanged after a valid driver exit marker is observed.
