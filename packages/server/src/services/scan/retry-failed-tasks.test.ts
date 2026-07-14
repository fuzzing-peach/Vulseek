import assert from "node:assert/strict";
import test from "node:test";
import { TRPCError } from "@trpc/server";
import { retryFailedScanJobTasksWithDeps } from "./retry-failed-tasks";
import type { ScanJob, Task } from "./types";

const makeScanJob = (overrides?: Partial<ScanJob>): ScanJob => ({
		scanJobId: "scan-job-1",
	title: "full scan",
	description: "",
	note: null,
	scanType: "full",
	status: "finished",
	triggerSource: "manual",
	commitSha: null,
	baseSha: null,
	targetRef: null,
	targetTag: null,
	scanRuntimeSettings: {},
	scanPipelineDefinitionSnapshot: {},
	commitWindow: 3,
	moduleTasksTotal: 0,
	moduleTasksCompleted: 0,
	moduleTasksFailed: 0,
	functionTasksTotal: 0,
	functionTasksCompleted: 0,
	functionTasksFailed: 0,
	applicationId: null,
	composeId: null,
	createdAt: "2026-05-04T00:00:00.000Z",
	startedAt: null,
	finishedAt: "2026-05-04T00:10:00.000Z",
	errorMessage: null,
	scanningThreadId: null,
	inputTokens: 0,
	outputTokens: 0,
	thoughtTokens: 0,
	totalTokens: 0,
	cachedReadTokens: 0,
	cachedWriteTokens: 0,
	repositoryTaskId: "scan-job-1",
	repositoryTaskStatus: "completed",
	...overrides,
});

const makeTask = (overrides?: Partial<Task>): Task => ({
		taskId: "task-1",
		scanJobId: "scan-job-1",
		vulnerabilityCandidateId: null,
	parentTaskId: null,
	name: "task",
	stageName: "identify-target",
	status: "pending",
	priority: null,
	attempt: 0,
	agentProfile: null,
	containerName: null,
	containerIndex: null,
	threadId: null,
	runtimeMode: "new_session",
	forkedFromTaskId: null,
	forkedFromThreadId: null,
	stageGroupInstanceId: null,
	input: null,
	output: null,
	inputTokens: null,
	outputTokens: null,
	thoughtTokens: null,
	totalTokens: null,
	cachedReadTokens: null,
	cachedWriteTokens: null,
	errorMessage: null,
	exitReason: null,
	exitNote: null,
	startedAt: null,
	completedAt: null,
	createdAt: "2026-05-04T00:00:00.000Z",
	updatedAt: "2026-05-04T00:00:00.000Z",
	...overrides,
});

test("retryFailedScanJobTasksWithDeps retries every failed task type in stage order", async () => {
	const tasks: Task[] = [
		makeTask({
			taskId: "delta-scope-1",
			stageName: "delta-scope",
			status: "failed",
			name: "delta-scoping",
			createdAt: "2026-05-04T00:00:30.000Z",
		}),
		makeTask({
			taskId: "repository-profile-1",
			stageName: "repository-profile",
			status: "failed",
			name: "repository profile",
			createdAt: "2026-05-04T00:01:30.000Z",
		}),
		makeTask({
			taskId: "attack-surface-model-1",
			stageName: "attack-surface-model",
			status: "failed",
			name: "attack surface model",
			createdAt: "2026-05-04T00:02:30.000Z",
		}),
		makeTask({
			taskId: "identify-target-1",
			stageName: "identify-target",
			status: "failed",
			name: "identify target",
			createdAt: "2026-05-04T00:03:30.000Z",
		}),
		makeTask({
			taskId: "scan-target-1",
			stageName: "scan-target",
			status: "failed",
			name: "scan target",
			createdAt: "2026-05-04T00:04:30.000Z",
		}),
		makeTask({
			taskId: "analyze-finding-1",
			stageName: "analyze-finding",
			status: "failed",
			name: "analyze finding",
			createdAt: "2026-05-04T00:05:30.000Z",
		}),
		makeTask({
			taskId: "critique-finding-1",
			stageName: "critique-finding",
			status: "failed",
			name: "critique finding",
			createdAt: "2026-05-04T00:06:30.000Z",
		}),
		makeTask({
			taskId: "verify-finding-1",
			stageName: "verify-finding",
			status: "failed",
			name: "verify finding",
			createdAt: "2026-05-04T00:07:30.000Z",
		}),
		makeTask({
			taskId: "triage-finding-1",
			stageName: "triage-finding",
			status: "failed",
			name: "triage finding",
			createdAt: "2026-05-04T00:08:30.000Z",
		}),
	];

	const removed: string[] = [];
	const cleared: string[] = [];
	const reset: string[] = [];
	const enqueued: string[] = [];
	const scanJobReset: Array<{ scanJobId: string }> = [];
	let recalculated = 0;

	const result = await retryFailedScanJobTasksWithDeps("scan-job-1", {
		loadScanJob: async () => makeScanJob(),
		listTasks: async () => tasks,
		removeQueuedTask: async (_scanJobId, task) => {
			removed.push(task.taskId);
		},
		clearTaskArtifacts: async (_scanJobId, task) => {
			cleared.push(task.taskId);
		},
		resetFailedTask: async (taskId) => {
			reset.push(taskId);
		},
		enqueueTask: async (_scanJobId, task) => {
			enqueued.push(task.taskId);
		},
		recalculateScanTaskCounts: async () => {
			recalculated += 1;
		},
		resetScanJobForRetry: async (input) => {
			scanJobReset.push(input);
		},
	});

	assert.deepEqual(result.retriedTasksByStage, {
		"delta-scope": 1,
		"repository-profile": 1,
		"attack-surface-model": 1,
		"identify-target": 1,
		"scan-target": 1,
		"analyze-finding": 1,
		"critique-finding": 1,
		"verify-finding": 1,
		"triage-finding": 1,
	});
	assert.equal(result.retriedTaskCount, 9);
	assert.deepEqual(removed, [
		"delta-scope-1",
		"repository-profile-1",
		"attack-surface-model-1",
		"identify-target-1",
		"scan-target-1",
		"analyze-finding-1",
		"critique-finding-1",
		"verify-finding-1",
		"triage-finding-1",
	]);
	assert.deepEqual(cleared, removed);
	assert.deepEqual(reset, removed);
	assert.deepEqual(enqueued, removed);
	assert.equal(recalculated, 1);
	assert.deepEqual(scanJobReset, [
		{
			scanJobId: "scan-job-1",
		},
	]);
});

test("retryFailedScanJobTasksWithDeps retries failed tasks without phase bookkeeping", async () => {
	const result = await retryFailedScanJobTasksWithDeps("scan-job-1", {
		loadScanJob: async () => makeScanJob(),
		listTasks: async () => [
			makeTask({
				taskId: "verify-finding-1",
				stageName: "verify-finding",
				status: "failed",
			}),
			makeTask({
				taskId: "scan-target-1",
				stageName: "scan-target",
				status: "failed",
			}),
		],
		removeQueuedTask: async () => {},
		clearTaskArtifacts: async () => {},
		resetFailedTask: async () => {},
		enqueueTask: async () => {},
		recalculateScanTaskCounts: async () => {},
		resetScanJobForRetry: async () => {},
	});

	assert.equal(result.retriedTaskCount, 2);
});

test("retryFailedScanJobTasksWithDeps rejects when the job still has running tasks", async () => {
	await assert.rejects(
		retryFailedScanJobTasksWithDeps("scan-job-1", {
			loadScanJob: async () => makeScanJob(),
			listTasks: async () => [
				makeTask({
					taskId: "failed-1",
					stageName: "identify-target",
					status: "failed",
				}),
				makeTask({
					taskId: "running-1",
					stageName: "analyze-finding",
					status: "running",
				}),
			],
			removeQueuedTask: async () => {},
			clearTaskArtifacts: async () => {},
			resetFailedTask: async () => {},
			enqueueTask: async () => {},
			recalculateScanTaskCounts: async () => {},
			resetScanJobForRetry: async () => {},
		}),
		(error: unknown) =>
			error instanceof TRPCError &&
			error.code === "CONFLICT" &&
			error.message === "Scan job is still running tasks",
	);
});

test("retryFailedScanJobTasksWithDeps rejects when there are no failed tasks", async () => {
	await assert.rejects(
		retryFailedScanJobTasksWithDeps("scan-job-1", {
			loadScanJob: async () => makeScanJob(),
			listTasks: async () => [
				makeTask({
					taskId: "completed-1",
					stageName: "scan-target",
					status: "completed",
				}),
			],
			removeQueuedTask: async () => {},
			clearTaskArtifacts: async () => {},
			resetFailedTask: async () => {},
			enqueueTask: async () => {},
			recalculateScanTaskCounts: async () => {},
			resetScanJobForRetry: async () => {},
		}),
		(error: unknown) =>
			error instanceof TRPCError &&
			error.code === "BAD_REQUEST" &&
			error.message === "No failed tasks to retry",
	);
});
