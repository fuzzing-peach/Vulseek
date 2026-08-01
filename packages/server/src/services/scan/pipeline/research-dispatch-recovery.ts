export type PendingResearchDispatch = {
	taskId: string;
	stageName: string;
	downstreamRouteKey: string | null;
	input: unknown;
	output: unknown;
};

export type ResearchDispatchRetryPlan = {
	ready: PendingResearchDispatch[];
	skipped: PendingResearchDispatch[];
};

/**
 * Keep recovery deterministic when a database read contains duplicate rows or
 * a task belongs to a stage that is not present in the current snapshot.
 */
export const buildResearchDispatchRetryPlan = (
	pendingTasks: readonly PendingResearchDispatch[],
	knownStageNames: ReadonlySet<string>,
): ResearchDispatchRetryPlan => {
	const ready: PendingResearchDispatch[] = [];
	const skipped: PendingResearchDispatch[] = [];
	const seenTaskIds = new Set<string>();

	for (const task of pendingTasks) {
		if (seenTaskIds.has(task.taskId) || !knownStageNames.has(task.stageName)) {
			skipped.push(task);
			continue;
		}
		seenTaskIds.add(task.taskId);
		ready.push(task);
	}

	return { ready, skipped };
};
