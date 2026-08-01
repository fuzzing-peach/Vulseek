export type RunningTaskStage =
	| "delta-scope"
	| "repository-profile"
	| "attack-surface-model"
	| "identify-target"
	| "scan-target"
	| "analyze-finding"
	| "critique-finding"
	| "verify-finding"
	| "triage-finding"
	| "research-scope"
	| "surface-map"
	| "track-plan"
	| "vulnerability-discovery"
	| "track-review"
	| "finding-validation"
	| "finding-review"
	| "chain-synthesis"
	| "chain-review"
	| "exploit-validation"
	| "exploit-review"
	| "research-report";

export const RESEARCH_RUNNING_TASK_STAGES = [
	"research-scope",
	"surface-map",
	"track-plan",
	"vulnerability-discovery",
	"track-review",
	"finding-validation",
	"finding-review",
	"chain-synthesis",
	"chain-review",
	"exploit-validation",
	"exploit-review",
	"research-report",
] as const satisfies readonly RunningTaskStage[];

export const RESEARCH_RUNNING_TASK_STAGE_DISPLAY_NAMES: Record<
	(typeof RESEARCH_RUNNING_TASK_STAGES)[number],
	string
> = {
	"research-scope": "Research Scope",
	"surface-map": "Surface Map",
	"track-plan": "Track Plan",
	"vulnerability-discovery": "Vulnerability Discovery",
	"track-review": "Track Review",
	"finding-validation": "Finding Validation",
	"finding-review": "Finding Review",
	"chain-synthesis": "Chain Synthesis",
	"chain-review": "Chain Review",
	"exploit-validation": "Exploit Validation",
	"exploit-review": "Exploit Review",
	"research-report": "Research Report",
};

export const isResearchRunningTaskStage = (
	stageName: string,
): stageName is (typeof RESEARCH_RUNNING_TASK_STAGES)[number] =>
	(RESEARCH_RUNNING_TASK_STAGES as readonly string[]).includes(stageName);

export const getResearchRunningTaskPresentation = (
	stageName: string,
	taskName: string,
) => {
	if (!isResearchRunningTaskStage(stageName)) {
		return null;
	}
	return {
		title: taskName,
		subtitle: RESEARCH_RUNNING_TASK_STAGE_DISPLAY_NAMES[stageName],
		stage: stageName,
	};
};

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
		case "research-scope":
		case "surface-map":
		case "track-plan":
		case "vulnerability-discovery":
		case "track-review":
		case "finding-validation":
		case "finding-review":
		case "chain-synthesis":
		case "chain-review":
		case "exploit-validation":
		case "exploit-review":
		case "research-report":
			return stageName;
		default:
			return null;
	}
};
