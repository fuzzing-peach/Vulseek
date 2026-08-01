export type PendingQueueTarget = {
	taskId: string;
	stageName: string;
	groupInstanceId: string | null;
};

export type StageRuntimePolicy = {
	stageName: string;
	disabled: boolean;
	concurrency: number;
};

export type RuntimeLoopSnapshot<
	TActiveTask = unknown,
	TPendingTask = unknown,
> = {
	status: string | null;
	activeCountByStage: Map<string, number>;
	activeTasksByStage: Map<string, TActiveTask[]>;
	pendingTargets: PendingQueueTarget[];
	pendingTaskMetadata: TPendingTask[];
	stagePolicies: Map<string, StageRuntimePolicy>;
	statusCounts: Array<{ stageName: string; status: string; count: number }>;
};

export const getPollableStageNames = (snapshot: RuntimeLoopSnapshot) => {
	const pendingStageNames = new Set(
		snapshot.pendingTargets.map((target) => target.stageName),
	);
	return [...snapshot.stagePolicies.values()]
		.filter((policy) => {
			if (policy.disabled || !pendingStageNames.has(policy.stageName)) {
				return false;
			}
			return (
				snapshot.activeCountByStage.get(policy.stageName) ?? 0
			) < policy.concurrency;
		})
		.map((policy) => policy.stageName);
};

export const groupActiveTasksByStage = <T extends { stageName: string }>(
	tasks: T[],
) => {
	const grouped = new Map<string, T[]>();
	for (const task of tasks) {
		const stageTasks = grouped.get(task.stageName) ?? [];
		stageTasks.push(task);
		grouped.set(task.stageName, stageTasks);
	}
	return grouped;
};
