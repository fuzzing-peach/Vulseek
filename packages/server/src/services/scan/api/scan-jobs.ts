import { db } from "@vulseek/server/db";
import { applications, compose, tasks } from "@vulseek/server/db/schema";
import type { apiCreateScanJob } from "@vulseek/server/db/schema";
import type { ScanStageSettings } from "@vulseek/server/db/schema";
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
	updateScanJobPipelineDefinitionSnapshotRepo,
	updateScanJobRuntimeSettingsRepo,
	updateScanJobRepositoryTaskStatusRepo,
	updateScanJobStatusRepo,
} from "../persistence/scan-job.repo";
import {
	buildCompleteScanRuntimeSettings,
	normalizeScanRuntimeSettings,
} from "../runtime-settings";
import type { ScanPipelineDefinitions } from "../pipeline/scan-pipeline-definitions";

const resolveCreateScanJobTargetStageSettings = async (
	input: typeof apiCreateScanJob._type,
): Promise<ScanStageSettings> => {
	if (input.applicationId) {
		const [row] = await db
			.select({ scanStageSettings: applications.scanStageSettings })
			.from(applications)
			.where(eq(applications.applicationId, input.applicationId))
			.limit(1);
		return row?.scanStageSettings ?? {};
	}
	if (input.composeId) {
		const [row] = await db
			.select({ scanStageSettings: compose.scanStageSettings })
			.from(compose)
			.where(eq(compose.composeId, input.composeId))
			.limit(1);
		return row?.scanStageSettings ?? {};
	}
	return {};
};

export const createScanJob = async (input: typeof apiCreateScanJob._type) => {
	const targetStageSettings =
		await resolveCreateScanJobTargetStageSettings(input);
	const scanRuntimeSettings = buildCompleteScanRuntimeSettings({
		scanType: input.scanType,
		targetStageSettings,
		runtimeOverrides: input.scanRuntimeSettings ?? {},
	});
	return await createScanJobRepo({
		...input,
		scanRuntimeSettings,
		defaultDeltaCommitWindow: DEFAULT_DELTA_COMMIT_WINDOW,
	});
};

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

export const updateScanJobPipelineDefinitionSnapshot = async (
	scanJobId: string,
	scanPipelineDefinitionSnapshot: unknown,
) => {
	if (
		!scanPipelineDefinitionSnapshot ||
		typeof scanPipelineDefinitionSnapshot !== "object" ||
		!("stages" in scanPipelineDefinitionSnapshot) ||
		!("pipelines" in scanPipelineDefinitionSnapshot)
	) {
		throw new Error("Invalid scan pipeline definition snapshot");
	}
	return await updateScanJobPipelineDefinitionSnapshotRepo(
		scanJobId,
		scanPipelineDefinitionSnapshot as ScanPipelineDefinitions,
	);
};

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
