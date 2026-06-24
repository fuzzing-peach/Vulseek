import type { apiCreateScanJob } from "@dokploy/server/db/schema";
import { DEFAULT_DELTA_COMMIT_WINDOW } from "../constants";
import {
	createScanJobRepo,
	findScanJobByIdRepo,
	listScanJobsByApplicationIdRepo,
	listScanJobsByComposeIdRepo,
	recalculateScanTaskCountsRepo,
	resetScanJobForRetryRepo,
	sumClaudeCodeCachedReadTokensByScanJobIdRepo,
	updateScanJobNoteRepo,
	updateScanJobRuntimeSettingsRepo,
	updateScanJobRepositoryTaskStatusRepo,
	updateScanJobStatusRepo,
} from "../persistence/scan-job.repo";
import { normalizeScanRuntimeSettings } from "../runtime-settings";

export const createScanJob = async (input: typeof apiCreateScanJob._type) =>
	await createScanJobRepo({
		...input,
		defaultDeltaCommitWindow: DEFAULT_DELTA_COMMIT_WINDOW,
	});

export const findScanJobById = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const claudeCachedReadTokens =
		await sumClaudeCodeCachedReadTokensByScanJobIdRepo(scanJobId);
	return {
		...scanJob,
		inputTokens: scanJob.inputTokens + claudeCachedReadTokens,
	};
};

export const findAllScanJobsByApplicationId = async (applicationId: string) =>
	await listScanJobsByApplicationIdRepo(applicationId);

export const findAllScanJobsByComposeId = async (composeId: string) =>
	await listScanJobsByComposeIdRepo(composeId);

export const updateScanJobNote = async (
	scanJobId: string,
	note: string | null,
) => await updateScanJobNoteRepo(scanJobId, note);

export const updateScanJobRuntimeSettings = async (
	scanJobId: string,
	scanRuntimeSettings: unknown,
) =>
	await updateScanJobRuntimeSettingsRepo(
		scanJobId,
		normalizeScanRuntimeSettings(scanRuntimeSettings),
	);

export const updateScanJobStatus = async (
	scanJobId: string,
	status:
		| "pending"
		| "running"
		| "paused"
		| "finished"
		| "failed"
		| "canceled",
	errorMessage?: string,
) => await updateScanJobStatusRepo(scanJobId, status, errorMessage);

export const resetScanJobForRetry = async (
	scanJobId: string,
	input?: {
		status?:
			| "pending"
			| "running"
			| "paused"
			| "finished"
			| "failed"
			| "canceled";
		errorMessage?: string | null;
		repositoryTaskStatus?: "pending" | "launching" | "launched" | "starting" | "running" | "completed" | "failed" | "exited" | "canceled";
	},
) => await resetScanJobForRetryRepo(scanJobId, input);

export const updateScanJobRepositoryTaskStatus = async (
	scanJobId: string,
	repositoryTaskStatus: "pending" | "launching" | "launched" | "starting" | "running" | "completed" | "failed" | "exited" | "canceled",
) => await updateScanJobRepositoryTaskStatusRepo(scanJobId, repositoryTaskStatus);

export const recalculateScanTaskCounts = async (scanJobId: string) =>
	await recalculateScanTaskCountsRepo(scanJobId);
