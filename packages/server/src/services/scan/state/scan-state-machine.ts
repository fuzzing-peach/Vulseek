export type ScanPipelineJobStatus =
	| "pending"
	| "running"
	| "finished"
	| "canceled";

export type ResolveScanPipelineStateInput = {
	scanJobStatus: ScanPipelineJobStatus;
	repositoryTaskStatus:
		| "pending"
		| "launching"
		| "launched"
		| "starting"
		| "running"
		| "completed"
		| "failed"
		| "exited"
		| "canceled";
	modulePendingCount: number;
	functionPendingCount: number;
	moduleFailed: number;
	functionFailed: number;
	analysisPendingCount: number;
	analysisFailed: number;
	verificationPendingCount: number;
	verificationFailed: number;
	triagePendingCount?: number;
	triageFailed?: number;
};

export type ResolvedScanPipelineState = {
	status: ScanPipelineJobStatus;
	errorMessage?: string;
};

export const resolveNextScanPipelineState = (
	input: ResolveScanPipelineStateInput,
): ResolvedScanPipelineState => {
	const repositoryPending =
		input.repositoryTaskStatus !== "completed" &&
		input.repositoryTaskStatus !== "failed" &&
		input.repositoryTaskStatus !== "exited" &&
		input.repositoryTaskStatus !== "canceled";

	if (
		repositoryPending ||
		input.functionPendingCount > 0 ||
		input.modulePendingCount > 0 ||
		input.analysisPendingCount > 0 ||
		input.verificationPendingCount > 0 ||
		(input.triagePendingCount ?? 0) > 0
	) {
		return {
			status: "running",
		};
	}

	if (input.repositoryTaskStatus === "failed") {
		return {
			status: "finished",
			errorMessage: "Repository scanning failed",
		};
	}

	return {
		status: "finished",
	};
};
