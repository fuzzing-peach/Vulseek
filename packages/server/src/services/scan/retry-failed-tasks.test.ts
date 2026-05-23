import assert from "node:assert/strict";
import test from "node:test";
import { TRPCError } from "@trpc/server";
import {
	retryFailedScanJobTasksWithDeps,
} from "./retry-failed-tasks";
import type {
	ScanJob,
	Task,
} from "./types";

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
	repositoryTaskId: "scan-job-1",
	repositoryTaskStatus: "completed",
	...overrides,
});

const makeTask = (overrides?: Partial<Task>): Task => ({
	taskId: "task-1",
	scanJobId: "scan-job-1",
	parentTaskId: null,
	name: "task",
	stageName: "module-scan",
	status: "pending",
	priority: null,
	attempt: 0,
	agentProfile: null,
	containerName: null,
	threadId: null,
	runtimeMode: "new_session",
	forkedFromTaskId: null,
	forkedFromThreadId: null,
	stageGroupInstanceId: null,
	input: null,
	output: null,
	tokenUsage: null,
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
			taskId: "verify-1",
			stageName: "verify",
			status: "failed",
			name: "verify task",
			createdAt: "2026-05-04T00:05:00.000Z",
		}),
		makeTask({
			taskId: "function-1",
			stageName: "function-scan",
			status: "failed",
			name: "function task",
			createdAt: "2026-05-04T00:03:00.000Z",
		}),
		makeTask({
			taskId: "repo-1",
			stageName: "repository-scan",
			status: "failed",
			name: "repository-scanning",
			createdAt: "2026-05-04T00:01:00.000Z",
		}),
		makeTask({
			taskId: "analysis-1",
			stageName: "analyze",
			status: "failed",
			name: "analysis task",
			createdAt: "2026-05-04T00:04:00.000Z",
		}),
		makeTask({
			taskId: "module-1",
			stageName: "module-scan",
			status: "failed",
			name: "module task",
			createdAt: "2026-05-04T00:02:00.000Z",
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
		"repository-scan": 1,
		"module-scan": 1,
		"function-scan": 1,
		analyze: 1,
		verify: 1,
	});
	assert.equal(result.retriedTaskCount, 5);
	assert.deepEqual(removed, [
		"repo-1",
		"module-1",
		"function-1",
		"analysis-1",
		"verify-1",
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
				taskId: "verify-1",
				stageName: "verify",
				status: "failed",
			}),
			makeTask({
				taskId: "function-1",
				stageName: "function-scan",
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
					stageName: "module-scan",
					status: "failed",
				}),
				makeTask({
					taskId: "running-1",
					stageName: "analyze",
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
					stageName: "function-scan",
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
