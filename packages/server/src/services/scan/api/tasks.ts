import {
	bindTaskRuntimeRepo,
	cancelOpenTasksByScanJobIdRepo,
	countTasksByScanJobAndStatusRepo,
	countTasksByScanJobStageAndStatusRepo,
	createTaskRepo,
	findTaskByIdRepo,
	listChildTasksByParentTaskIdRepo,
	listTasksByScanJobAndStageRepo,
	listTasksByScanJobIdRepo,
	resetFailedTaskForRetryRepo,
	storeTaskInputRepo,
	storeTaskOutputRepo,
	updateTaskRepo,
	updateTaskStatusRepo,
} from "../persistence/task.repo";
import type { Task } from "../types";
import { computeTaskCost } from "../cost";
import {
	normalizeTaskApiTokenUsage,
	normalizeTasksApiTokenUsage,
} from "./token-usage";
import type { TaskAgentProfileSnapshot } from "@dokploy/server/db/schema";

const withEstimatedCost = <T extends Task>(task: T) => ({
	...task,
	estimatedCost: computeTaskCost(
		task.inputTokens,
		task.outputTokens,
		task.cachedReadTokens,
		task.agentProfile as TaskAgentProfileSnapshot | null,
	),
});

export const createTask = async (input: Parameters<typeof createTaskRepo>[0]) =>
	await createTaskRepo(input);

export const findTaskById = async (taskId: string) =>
	withEstimatedCost(normalizeTaskApiTokenUsage(await findTaskByIdRepo(taskId)));

export const findTasksByScanJobId = async (scanJobId: string) =>
	normalizeTasksApiTokenUsage(await listTasksByScanJobIdRepo(scanJobId)).map(withEstimatedCost);

export const findChildTasksByParentTaskId = async (parentTaskId: string) =>
	normalizeTasksApiTokenUsage(
		await listChildTasksByParentTaskIdRepo(parentTaskId),
	).map(withEstimatedCost);

export const findTasksByScanJobAndStage = async (input: {
	scanJobId: string;
	stageName: string;
}) => normalizeTasksApiTokenUsage(await listTasksByScanJobAndStageRepo(input)).map(withEstimatedCost);

export const updateTask = async (taskId: string, patch: Partial<Task>) =>
	await updateTaskRepo(taskId, patch);

export const updateTaskStatus = async (
	taskId: string,
	status:
		| "pending"
		| "launching"
		| "launched"
		| "starting"
		| "running"
		| "completed"
		| "failed"
		| "exited"
		| "canceled",
	errorMessage?: string | null,
) => await updateTaskStatusRepo({ taskId, status, errorMessage });

export const cancelOpenScanJobTasks = async (
	scanJobId: string,
	errorMessage?: string | null,
) => await cancelOpenTasksByScanJobIdRepo(scanJobId, errorMessage);

export const bindTaskRuntime = async (input: {
	taskId: string;
	containerName?: string | null;
	containerIndex?: number | null;
	threadId?: string | null;
	agentProfile?: Task["agentProfile"];
}) => await bindTaskRuntimeRepo(input);

export const storeTaskInput = async (taskId: string, input: Task["input"]) =>
	await storeTaskInputRepo(taskId, input);

export const storeTaskOutput = async (taskId: string, output: Task["output"]) =>
	await storeTaskOutputRepo(taskId, output);

export const resetFailedTaskForRetry = async (taskId: string) =>
	await resetFailedTaskForRetryRepo(taskId);

export const countTasksByScanJobAndStatus = async (scanJobId: string) =>
	await countTasksByScanJobAndStatusRepo(scanJobId);

export const countTasksByScanJobStageAndStatus = async (scanJobId: string) =>
	await countTasksByScanJobStageAndStatusRepo(scanJobId);
