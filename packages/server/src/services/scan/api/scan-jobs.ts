import { TRPCError } from "@trpc/server";
import {
	createScanJobRepo,
	findScanJobByIdRepo,
	listScanJobsByApplicationIdPageRepo,
	listScanJobsByComposeIdPageRepo,
	resetScanJobForRetryRepo,
	type ScanJobListPageInput,
	updateScanJobNoteRepo,
	updateScanJobPipelineDefinitionSnapshotRepo,
	updateScanJobRepositoryTaskStatusRepo,
	updateScanJobRuntimeSettingsRepo,
	updateScanJobStatusRepo,
	transitionScanJobStatusRepo,
} from "../persistence/scan-job.repo";
import { findScanJobOrganizationIdRepo } from "../persistence/scan-job-access.repo";
import { wakePipelineRuntimesForScanJob } from "../pipeline/pipeline-runner";
import {
	normalizePipelineDefinitionSnapshot,
	type ScanPipelineDefinitions,
} from "../pipeline/scan-pipeline-definitions";
import {
	normalizeScanRuntimeSettings,
} from "../runtime-settings";

export const authorizeScanJobAccess = async (
	scanJobId: string,
	organizationId: string | null | undefined,
) => {
	const targetOrganizationId = await findScanJobOrganizationIdRepo(scanJobId);
	if (!targetOrganizationId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invalid scan job target",
		});
	}
	if (targetOrganizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this scan job",
		});
	}
	return targetOrganizationId;
};

export const findScanJobById = async (scanJobId: string) => {
	return await findScanJobByIdRepo(scanJobId);
};

export const findScanJobsByApplicationIdPage = async (
	applicationId: string,
	input: ScanJobListPageInput,
) => {
	const { items, total } = await listScanJobsByApplicationIdPageRepo(
		applicationId,
		input,
	);
	return { items, total, page: input.page, pageSize: input.pageSize };
};

export const findScanJobsByComposeIdPage = async (
	composeId: string,
	input: ScanJobListPageInput,
) => {
	const { items, total } = await listScanJobsByComposeIdPageRepo(
		composeId,
		input,
	);
	return { items, total, page: input.page, pageSize: input.pageSize };
};

export const updateScanJobNote = async (
	scanJobId: string,
	note: string | null,
) => await updateScanJobNoteRepo(scanJobId, note);

export const updateScanJobRuntimeSettings = async (
	scanJobId: string,
	scanRuntimeSettings: unknown,
) => {
	const updated = await updateScanJobRuntimeSettingsRepo(
		scanJobId,
		normalizeScanRuntimeSettings(scanRuntimeSettings),
	);
	wakePipelineRuntimesForScanJob(scanJobId);
	return updated;
};

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
		normalizePipelineDefinitionSnapshot(
			scanPipelineDefinitionSnapshot as ScanPipelineDefinitions,
		),
	);
};

export const updateScanJobStatus = async (
	scanJobId: string,
	status:
		| "pending"
		| "running"
		| "paused"
		| "finalizing"
		| "finished"
		| "partially_finished"
		| "failed"
		| "canceled",
	errorMessage?: string,
) => await updateScanJobStatusRepo(scanJobId, status, errorMessage);

export const transitionScanJobStatus = async (input: {
	scanJobId: string;
	from: Array<
		| "pending"
		| "running"
		| "paused"
		| "finalizing"
		| "finished"
		| "partially_finished"
		| "failed"
		| "canceled"
	>;
	to:
		| "pending"
		| "running"
		| "paused"
		| "finalizing"
		| "finished"
		| "partially_finished"
		| "failed"
		| "canceled";
	errorMessage?: string | null;
	terminationReason?: string | null;
}) => await transitionScanJobStatusRepo(input);

export const resetScanJobForRetry = async (
	scanJobId: string,
	input?: {
		status?:
			| "pending"
			| "running"
			| "paused"
			| "finalizing"
			| "finished"
			| "partially_finished"
			| "failed"
			| "canceled";
		errorMessage?: string | null;
		repositoryTaskStatus?:
			| "pending"
			| "launching"
			| "launched"
			| "starting"
			| "running"
			| "completed"
			| "failed"
			| "exited"
			| "canceled";
	},
) => await resetScanJobForRetryRepo(scanJobId, input);

export const updateScanJobRepositoryTaskStatus = async (
	scanJobId: string,
	repositoryTaskStatus:
		| "pending"
		| "launching"
		| "launched"
		| "starting"
		| "running"
		| "completed"
		| "failed"
		| "exited"
		| "canceled",
) =>
	await updateScanJobRepositoryTaskStatusRepo(scanJobId, repositoryTaskStatus);
