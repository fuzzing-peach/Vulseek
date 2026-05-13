import type { Task } from "../types";
import {
	bindTaskRuntimeRepo,
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
	storeTaskRawOutputRepo,
	updateTaskRepo,
	updateTaskStatusRepo,
} from "../persistence/task.repo";

export const createTask = async (
	input: Parameters<typeof createTaskRepo>[0],
) => await createTaskRepo(input);

export const findTaskById = async (taskId: string) =>
	await findTaskByIdRepo(taskId);

export const findTasksByScanJobId = async (scanJobId: string) =>
	await listTasksByScanJobIdRepo(scanJobId);

export const findChildTasksByParentTaskId = async (parentTaskId: string) =>
	await listChildTasksByParentTaskIdRepo(parentTaskId);

export const findTasksByScanJobAndStage = async (input: {
	scanJobId: string;
	stageName: string;
}) => await listTasksByScanJobAndStageRepo(input);

export const updateTask = async (
	taskId: string,
	patch: Partial<Task>,
) => await updateTaskRepo(taskId, patch);

export const updateTaskStatus = async (
	taskId: string,
	status: "pending" | "launching" | "running" | "completed" | "failed",
	errorMessage?: string | null,
) => await updateTaskStatusRepo({ taskId, status, errorMessage });

export const bindTaskRuntime = async (input: {
	taskId: string;
	containerName?: string | null;
	threadId?: string | null;
	agentProfile?: Task["agentProfile"];
}) => await bindTaskRuntimeRepo(input);

export const storeTaskInput = async (taskId: string, input: Task["input"]) =>
	await storeTaskInputRepo(taskId, input);

export const storeTaskOutput = async (taskId: string, output: Task["output"]) =>
	await storeTaskOutputRepo(taskId, output);

export const storeTaskRawOutput = async (taskId: string, rawOutput: string) =>
	await storeTaskRawOutputRepo(taskId, rawOutput);

export const resetFailedTaskForRetry = async (taskId: string) =>
	await resetFailedTaskForRetryRepo(taskId);

export const countTasksByScanJobAndStatus = async (scanJobId: string) =>
	await countTasksByScanJobAndStatusRepo(scanJobId);

export const countTasksByScanJobStageAndStatus = async (scanJobId: string) =>
	await countTasksByScanJobStageAndStatusRepo(scanJobId);
