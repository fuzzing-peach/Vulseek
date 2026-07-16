export type ScanPipelineJobStatus =
	| "pending"
	| "running"
	| "paused"
	| "finalizing"
	| "finished"
	| "partially_finished"
	| "failed"
	| "canceled";

export type TerminalScanJobStatus =
	| "finished"
	| "partially_finished"
	| "failed"
	| "canceled";

export const isTerminalScanTaskStatus = (status: string) =>
	status === "completed" ||
	status === "failed" ||
	status === "exited" ||
	status === "canceled";

export const resolveTerminalScanJobStatus = (input: {
	rootFailed: boolean;
	failedTaskCount: number;
	canceled: boolean;
}): TerminalScanJobStatus => {
	if (input.canceled) {
		return "canceled";
	}
	if (input.rootFailed) {
		return "failed";
	}
	if (input.failedTaskCount > 0) {
		return "partially_finished";
	}
	return "finished";
};
