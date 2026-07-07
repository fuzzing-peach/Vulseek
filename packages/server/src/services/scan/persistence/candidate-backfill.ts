export type CandidateBackfillInput = {
	scanJobId?: string;
};

export type CandidateBackfillDeps = {
	listProducerTaskIds: (input: {
		scanJobId?: string;
		stageNames: readonly string[];
	}) => Promise<string[]>;
	syncProducerTask: (taskId: string) => Promise<{ synced: number }>;
};

export const backfillVulnerabilityCandidatesFromTasksWithDeps = async (
	input: CandidateBackfillInput | undefined,
	deps: CandidateBackfillDeps,
	stageNames: readonly string[],
) => {
	const taskIds = await deps.listProducerTaskIds({
		scanJobId: input?.scanJobId,
		stageNames,
	});
	let synced = 0;
	const warnings: Array<{ taskId: string; message: string }> = [];
	for (const taskId of taskIds) {
		try {
			const result = await deps.syncProducerTask(taskId);
			synced += result.synced;
		} catch (error) {
			warnings.push({
				taskId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return {
		tasks: taskIds.length,
		synced,
		warnings,
	};
};
