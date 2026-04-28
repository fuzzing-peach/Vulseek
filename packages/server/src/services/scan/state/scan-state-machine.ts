export type ScanPipelineJobStatus =
	| "queued"
	| "scanning"
	| "analyzing"
	| "verifying"
	| "completed"
	| "failed";

export type ScanPipelinePhase =
	| "queued"
	| "repository_scanning"
	| "module_scanning"
	| "function_scanning"
	| "analyzing"
	| "verifying"
	| "completed"
	| "failed";

export type ResolveScanPipelineStateInput = {
	scanJobStatus: ScanPipelineJobStatus;
	repositoryTaskStatus: "queued" | "running" | "completed" | "failed";
	modulePendingCount: number;
	functionPendingCount: number;
	moduleFailed: number;
	functionFailed: number;
	analysisPendingCount: number;
	analysisFailed: number;
	verificationPendingCount: number;
	verificationFailed: number;
};

export type ResolvedScanPipelineState = {
	status: ScanPipelineJobStatus;
	scanPhase: ScanPipelinePhase;
	errorMessage?: string;
};

export const resolveNextScanPipelineState = (
	input: ResolveScanPipelineStateInput,
): ResolvedScanPipelineState => {
	const repositoryPending =
		input.repositoryTaskStatus !== "completed" &&
		input.repositoryTaskStatus !== "failed";

	if (repositoryPending) {
		return {
			status: "scanning",
			scanPhase: "repository_scanning",
		};
	}

	if (input.functionPendingCount > 0) {
		return {
			status: "scanning",
			scanPhase: "function_scanning",
		};
	}

	if (input.modulePendingCount > 0) {
		return {
			status: "scanning",
			scanPhase: "module_scanning",
		};
	}

	if (input.repositoryTaskStatus === "failed") {
		return {
			status: "failed",
			scanPhase: "repository_scanning",
			errorMessage: "Repository scanning failed",
		};
	}

	if (input.moduleFailed > 0 || input.functionFailed > 0) {
		return {
			status: "failed",
			scanPhase: "function_scanning",
			errorMessage: `${input.moduleFailed} module tasks failed, ${input.functionFailed} function tasks failed`,
		};
	}

	if (input.analysisPendingCount > 0) {
		return {
			status: "analyzing",
			scanPhase: "analyzing",
		};
	}

	if (input.verificationPendingCount > 0) {
		return {
			status: "verifying",
			scanPhase: "verifying",
		};
	}

	if (input.analysisFailed > 0) {
		return {
			status: "failed",
			scanPhase: "analyzing",
			errorMessage: `${input.analysisFailed} candidate analyses failed`,
		};
	}

	if (input.verificationFailed > 0) {
		return {
			status: "failed",
			scanPhase: "verifying",
			errorMessage: `${input.verificationFailed} candidate verifications failed`,
		};
	}

	return {
		status: "completed",
		scanPhase: "completed",
	};
};
