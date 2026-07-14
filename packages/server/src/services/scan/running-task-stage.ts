export type RunningTaskStage =
	| "delta-scope"
	| "repository-profile"
	| "attack-surface-model"
	| "identify-target"
	| "scan-target"
	| "analyze-finding"
	| "critique-finding"
	| "verify-finding"
	| "triage-finding";

export const RUNNING_TASK_VIEW_STATUSES = [
	"launching",
	"launched",
	"starting",
	"running",
] as const;

export const mapRunningTaskStage = (
	stageName: string,
): RunningTaskStage | null => {
	switch (stageName) {
		case "delta-scope":
			return stageName;
		case "repository-profile":
			return stageName;
		case "attack-surface-model":
			return stageName;
		case "identify-target":
			return stageName;
		case "scan-target":
			return stageName;
		case "analyze-finding":
			return stageName;
		case "critique-finding":
			return stageName;
		case "verify-finding":
			return stageName;
		case "triage-finding":
			return stageName;
		default:
			return null;
	}
};
