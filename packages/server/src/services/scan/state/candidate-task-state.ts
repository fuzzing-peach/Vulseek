const ACTIVE_TASK_STATUSES = new Set([
	"pending",
	"launching",
	"launched",
	"starting",
	"running",
]);

const TERMINAL_TASK_STATUSES = new Set([
	"completed",
	"failed",
	"exited",
	"canceled",
]);

export const classifyCandidateTaskStage = (stageName: string) => {
	if (stageName === "analyze-finding" || stageName === "critique-finding") {
		return "analyzing" as const;
	}
	if (stageName === "verify-finding" || stageName === "triage-finding") {
		return "verifying" as const;
	}
	return null;
};

export type CandidateTaskStateTask = {
	taskId: string;
	stageName: string;
	status: string;
	createdAt: string;
};

export type CandidateTaskExecutionState = {
	latestTask: CandidateTaskStateTask | null;
	activeTask: CandidateTaskStateTask | null;
	activeStage: "analyzing" | "verifying" | null;
	latestStage: "analyzing" | "verifying" | null;
	isTerminal: boolean;
	canRerunAnalysis: boolean;
};

export const deriveCandidateTaskExecutionState = (
	tasks: CandidateTaskStateTask[],
): CandidateTaskExecutionState => {
	const sortedTasks = [...tasks].sort((left, right) =>
		right.createdAt.localeCompare(left.createdAt),
	);
	const latestTask = sortedTasks[0] || null;
	const activeTask =
		sortedTasks.find((task) => ACTIVE_TASK_STATUSES.has(task.status)) || null;
	const activeStage = activeTask
		? classifyCandidateTaskStage(activeTask.stageName)
		: null;
	const latestStage = latestTask
		? classifyCandidateTaskStage(latestTask.stageName)
		: null;

	return {
		latestTask,
		activeTask,
		activeStage,
		latestStage,
		isTerminal: latestTask
			? TERMINAL_TASK_STATUSES.has(latestTask.status)
			: false,
		canRerunAnalysis: latestTask
			? ["completed", "failed", "exited"].includes(latestTask.status)
			: false,
	};
};
