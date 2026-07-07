import { db } from "@vulseek/server/db";
import { tasks } from "@vulseek/server/db/schema";
import type { apiCreateScanJob } from "@vulseek/server/db/schema";
import { eq } from "drizzle-orm";
import { DEFAULT_DELTA_COMMIT_WINDOW } from "../constants";
import { computeTaskCost } from "../cost";
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
	const [scanJob, claudeCachedReadTokens, taskRows] = await Promise.all([
		findScanJobByIdRepo(scanJobId),
		sumClaudeCodeCachedReadTokensByScanJobIdRepo(scanJobId),
		db
			.select({
				inputTokens: tasks.inputTokens,
				outputTokens: tasks.outputTokens,
				cachedReadTokens: tasks.cachedReadTokens,
				agentProfile: tasks.agentProfile,
			})
			.from(tasks)
			.where(eq(tasks.scanJobId, scanJobId)),
	]);

	let estimatedCost: number | null = null;
	for (const row of taskRows) {
		const cost = computeTaskCost(row.inputTokens, row.outputTokens, row.cachedReadTokens, row.agentProfile);
		if (cost != null) {
			estimatedCost = (estimatedCost ?? 0) + cost;
		}
	}

	return {
		...scanJob,
		inputTokens: scanJob.inputTokens + claudeCachedReadTokens,
		estimatedCost,
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
