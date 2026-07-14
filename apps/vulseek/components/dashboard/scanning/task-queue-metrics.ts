type QueueTaskCounts = {
	queuedCount?: number | null;
	pendingCount?: number | null;
	launchingCount?: number | null;
	launchedCount?: number | null;
	runningCount?: number | null;
	startingCount?: number | null;
	completedCount: number;
	exitedCount?: number | null;
	concurrencyLimit?: number | null;
};

export const buildTaskQueueMetrics = (
	queue: QueueTaskCounts,
	pipelineConcurrencyLimit?: number | null,
) => {
	const queued =
		(queue.queuedCount ?? queue.pendingCount ?? 0) +
		(queue.launchingCount ?? 0) +
		(queue.launchedCount ?? 0);
	const running = (queue.runningCount ?? 0) + (queue.startingCount ?? 0);
	const done = queue.completedCount + (queue.exitedCount ?? 0);
	const concurrencyLimit = Math.max(
		1,
		Number(pipelineConcurrencyLimit ?? queue.concurrencyLimit ?? 1) || 1,
	);

	return { queued, running, done, concurrencyLimit };
};
