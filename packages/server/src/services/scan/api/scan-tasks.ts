import type { ScanFunctionTask, ScanModuleTask } from "../types";
import {
	createScanFunctionTaskRepo,
	findScanFunctionTaskByIdRepo,
	listScanFunctionTasksByModuleTaskIdRepo,
	listScanFunctionTasksByScanJobIdRepo,
	updateScanFunctionTaskRepo,
	updateScanFunctionTaskStatusRepo,
} from "../persistence/scan-function-task.repo";
import {
	createScanModuleTaskRepo,
	findScanModuleTaskByIdRepo,
	listScanModuleTasksByScanJobIdRepo,
	updateScanModuleTaskRepo,
	updateScanModuleTaskStatusRepo,
} from "../persistence/scan-module-task.repo";

export const createScanModuleTask = async (input: {
	scanJobId: string;
	moduleId: string;
	moduleName: string;
	priority?: number;
	attempt?: number;
	moduleScanMdPath?: string;
	moduleScanJsonPath?: string;
	functionPlanJsonPath?: string;
	containerName?: string;
	threadId?: string;
}) => await createScanModuleTaskRepo(input);

export const findScanModuleTasksByScanJobId = async (scanJobId: string) =>
	await listScanModuleTasksByScanJobIdRepo(scanJobId);

export const findScanModuleTaskById = async (scanModuleTaskId: string) =>
	await findScanModuleTaskByIdRepo(scanModuleTaskId);

export const updateScanModuleTask = async (
	scanModuleTaskId: string,
	patch: Partial<ScanModuleTask>,
) => await updateScanModuleTaskRepo(scanModuleTaskId, patch);

export const updateScanModuleTaskStatus = async (
	scanModuleTaskId: string,
	status: "queued" | "running" | "completed" | "failed",
	errorMessage?: string,
) => await updateScanModuleTaskStatusRepo(scanModuleTaskId, status, errorMessage);

export const createScanFunctionTask = async (input: {
	scanJobId: string;
	scanModuleTaskId: string;
	moduleId: string;
	moduleName: string;
	functionId: string;
	functionName: string;
	filePath?: string;
	line?: number;
	priority?: number;
	attempt?: number;
	score?: number;
	riskType?: string;
	summary?: string;
	functionScanMdPath?: string;
	functionScanJsonPath?: string;
	containerName?: string;
	threadId?: string;
}) => await createScanFunctionTaskRepo(input);

export const findScanFunctionTasksByScanJobId = async (scanJobId: string) =>
	await listScanFunctionTasksByScanJobIdRepo(scanJobId);

export const findScanFunctionTaskById = async (scanFunctionTaskId: string) =>
	await findScanFunctionTaskByIdRepo(scanFunctionTaskId);

export const findScanFunctionTasksByModuleTaskId = async (
	scanModuleTaskId: string,
) => await listScanFunctionTasksByModuleTaskIdRepo(scanModuleTaskId);

export const updateScanFunctionTask = async (
	scanFunctionTaskId: string,
	patch: Partial<ScanFunctionTask>,
) => await updateScanFunctionTaskRepo(scanFunctionTaskId, patch);

export const updateScanFunctionTaskStatus = async (
	scanFunctionTaskId: string,
	status: "queued" | "running" | "completed" | "failed",
	errorMessage?: string,
) => await updateScanFunctionTaskStatusRepo(scanFunctionTaskId, status, errorMessage);
