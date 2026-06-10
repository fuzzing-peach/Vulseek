import type { apiCreateScanJob } from "@dokploy/server/db/schema";
import { DEFAULT_DELTA_COMMIT_WINDOW } from "../constants";
import {
	createScanJobRepo,
	findScanJobByIdRepo,
	listScanJobsByApplicationIdRepo,
	listScanJobsByComposeIdRepo,
	recalculateScanTaskCountsRepo,
	resetScanJobForRetryRepo,
	updateScanJobNoteRepo,
	updateScanJobRepositoryTaskStatusRepo,
	updateScanJobStatusRepo,
} from "../persistence/scan-job.repo";

export const createScanJob = async (input: typeof apiCreateScanJob._type) =>
	await createScanJobRepo({
		...input,
		defaultDeltaCommitWindow: DEFAULT_DELTA_COMMIT_WINDOW,
	});

export const findScanJobById = async (scanJobId: string) =>
	await findScanJobByIdRepo(scanJobId);

export const findAllScanJobsByApplicationId = async (applicationId: string) =>
	await listScanJobsByApplicationIdRepo(applicationId);

export const findAllScanJobsByComposeId = async (composeId: string) =>
	await listScanJobsByComposeIdRepo(composeId);

export const updateScanJobNote = async (
	scanJobId: string,
	note: string | null,
) => await updateScanJobNoteRepo(scanJobId, note);

export const updateScanJobStatus = async (
	scanJobId: string,
	status: "pending" | "running" | "finished" | "canceled",
	errorMessage?: string,
) => await updateScanJobStatusRepo(scanJobId, status, errorMessage);

export const resetScanJobForRetry = async (
	scanJobId: string,
	input?: {
		status?: "pending" | "running" | "finished" | "canceled";
		errorMessage?: string | null;
		repositoryTaskStatus?: "pending" | "launching" | "running" | "completed" | "failed" | "exited" | "canceled";
	},
) => await resetScanJobForRetryRepo(scanJobId, input);

export const updateScanJobRepositoryTaskStatus = async (
	scanJobId: string,
	repositoryTaskStatus: "pending" | "launching" | "running" | "completed" | "failed" | "exited" | "canceled",
) => await updateScanJobRepositoryTaskStatusRepo(scanJobId, repositoryTaskStatus);

export const recalculateScanTaskCounts = async (scanJobId: string) =>
	await recalculateScanTaskCountsRepo(scanJobId);
