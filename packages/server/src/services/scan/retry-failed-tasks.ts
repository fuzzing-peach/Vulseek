import { TRPCError } from "@trpc/server";
import type {
	ScanJob,
	Task,
} from "./types";

export const RETRYABLE_TASK_STAGE_NAMES = [
	"delta-scope",
	"repository-profile",
	"attack-surface-model",
	"identify-target",
	"scan-target",
	"analyze-finding",
	"critique-finding",
	"verify-finding",
	"triage-finding",
	"repository-scan",
	"module-scan",
	"module-threat-model",
	"design-rule",
	"scan-rule",
	"scan-pattern",
	"sink-pre-analyze",
	"function-scan",
	"analyze",
	"verify",
	"triage",
] as const;

export type RetryableTaskStageName =
	(typeof RETRYABLE_TASK_STAGE_NAMES)[number];

export type RetryFailedTasksByStage = Record<RetryableTaskStageName, number>;

export type RetryFailedTasksResult = {
	scanJobId: string;
	retriedTaskCount: number;
	retriedTasksByStage: RetryFailedTasksByStage;
};

type RetryFailedTasksDeps = {
	loadScanJob: (scanJobId: string) => Promise<ScanJob>;
	listTasks: (scanJobId: string) => Promise<Task[]>;
	removeQueuedTask: (scanJobId: string, task: Task) => Promise<void>;
	clearTaskArtifacts: (scanJobId: string, task: Task) => Promise<void>;
	resetFailedTask: (taskId: string) => Promise<unknown>;
	enqueueTask: (scanJobId: string, task: Task) => Promise<void>;
	recalculateScanTaskCounts: (scanJobId: string) => Promise<unknown>;
	resetScanJobForRetry: (input: { scanJobId: string }) => Promise<unknown>;
};

const RETRY_STAGE_ORDER: Record<RetryableTaskStageName, number> = {
	"delta-scope": 0,
	"repository-profile": 1,
	"attack-surface-model": 2,
	"identify-target": 3,
	"scan-target": 4,
	"analyze-finding": 5,
	"critique-finding": 6,
	"verify-finding": 7,
	"triage-finding": 8,
	"repository-scan": 1,
	"module-scan": 2,
	"module-threat-model": 3,
	"design-rule": 4,
	"scan-rule": 5,
	"scan-pattern": 6,
	"sink-pre-analyze": 7,
	"function-scan": 8,
	analyze: 9,
	verify: 10,
	triage: 11,
};

const createEmptyRetryCounts = (): RetryFailedTasksByStage => ({
	"delta-scope": 0,
	"repository-profile": 0,
	"attack-surface-model": 0,
	"identify-target": 0,
	"scan-target": 0,
	"analyze-finding": 0,
	"critique-finding": 0,
	"verify-finding": 0,
	"triage-finding": 0,
	"repository-scan": 0,
	"module-scan": 0,
	"module-threat-model": 0,
	"design-rule": 0,
	"scan-rule": 0,
	"scan-pattern": 0,
	"sink-pre-analyze": 0,
	"function-scan": 0,
	analyze: 0,
	verify: 0,
	triage: 0,
});

export const isRetryableTaskStageName = (
	stageName: Task["stageName"],
): stageName is RetryableTaskStageName =>
	RETRYABLE_TASK_STAGE_NAMES.includes(stageName as RetryableTaskStageName);

export const sortRetryableTasksForRetry = (tasks: Task[]) =>
	[...tasks].sort((left, right) => {
		const stageDiff =
			RETRY_STAGE_ORDER[left.stageName as RetryableTaskStageName] -
			RETRY_STAGE_ORDER[right.stageName as RetryableTaskStageName];
		if (stageDiff !== 0) {
			return stageDiff;
		}
		return left.createdAt.localeCompare(right.createdAt);
	});

export const retryFailedScanJobTasksWithDeps = async (
	scanJobId: string,
	deps: RetryFailedTasksDeps,
): Promise<RetryFailedTasksResult> => {
	const scanJob = await deps.loadScanJob(scanJobId);
	if (scanJob.scanType !== "full" && scanJob.scanType !== "rule") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Retry failed tasks is only supported for full or rule scan jobs",
		});
	}
	if (scanJob.status !== "finished") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only finished full or rule scan jobs can retry failed tasks",
		});
	}

	const allTasks = await deps.listTasks(scanJobId);
	const runningTask = allTasks.find((task) => task.status === "running");
	if (runningTask) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Scan job is still running tasks",
		});
	}

	const failedTasks = sortRetryableTasksForRetry(
		allTasks.filter(
			(task) =>
				task.status === "failed" && isRetryableTaskStageName(task.stageName),
		),
	);
	if (failedTasks.length === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "No failed tasks to retry",
		});
	}

	const retriedTasksByStage = createEmptyRetryCounts();

	for (const task of failedTasks) {
		const stageName = task.stageName as RetryableTaskStageName;
		await deps.removeQueuedTask(scanJobId, task).catch(() => {});
		await deps.clearTaskArtifacts(scanJobId, task).catch(() => {});
		await deps.resetFailedTask(task.taskId);
		await deps.enqueueTask(scanJobId, task);
		retriedTasksByStage[stageName] += 1;
	}

	await deps.recalculateScanTaskCounts(scanJobId);
	await deps.resetScanJobForRetry({
		scanJobId,
	});

	return {
		scanJobId,
		retriedTaskCount: failedTasks.length,
		retriedTasksByStage,
	};
};
