export type ScanJobExecutionStatus =
	| "pending"
	| "running"
	| "paused"
	| "finalizing"
	| "finished"
	| "partially_finished"
	| "failed"
	| "canceled";

export type TaskExecutionStatus =
	| "pending"
	| "launching"
	| "launched"
	| "starting"
	| "running"
	| "completed"
	| "failed"
	| "exited"
	| "canceled";

export const ALL_TASK_EXECUTION_STATUSES: TaskExecutionStatus[] = [
	"pending",
	"launching",
	"launched",
	"starting",
	"running",
	"completed",
	"failed",
	"exited",
	"canceled",
];

export const getAllowedJobStatusesForTaskTransition = (
	to: TaskExecutionStatus,
): ScanJobExecutionStatus[] => {
	if (to === "completed" || to === "failed" || to === "exited") {
		return ["running", "paused"];
	}
	if (to === "canceled") {
		return ["pending", "running", "paused"];
	}
	return ["running"];
};

export const isTaskLaunchAllowed = (status: ScanJobExecutionStatus) =>
	status === "running";

export const isTaskCompletionAllowed = (status: ScanJobExecutionStatus) =>
	status === "running" || status === "paused";
