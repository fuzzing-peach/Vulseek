export type PipelineTaskUpdate = {
	status?:
		| "pending"
		| "launching"
		| "launched"
		| "starting"
		| "running"
		| "completed"
		| "failed"
		| "exited"
		| "canceled";
	errorMessage?: string;
	exitReason?: "agent_exit" | "leader_exit" | null;
	exitNote?: string | null;
	containerName?: string;
	threadId?: string;
	output?: unknown;
	vulnerabilityCandidateId?: string;
};

export const buildPipelineTaskUpdatePatch = (
	patch: PipelineTaskUpdate,
	now = new Date().toISOString(),
) => ({
	...(patch.containerName ? { containerName: patch.containerName } : {}),
	...(patch.threadId ? { threadId: patch.threadId } : {}),
	...(patch.output !== undefined ? { output: patch.output } : {}),
	...(patch.vulnerabilityCandidateId
		? { vulnerabilityCandidateId: patch.vulnerabilityCandidateId }
		: {}),
	...(patch.status
		? {
				status: patch.status,
				errorMessage: patch.errorMessage,
				exitReason: patch.exitReason,
				exitNote: patch.exitNote,
				...(["launching", "launched", "starting", "running"].includes(
					patch.status,
				)
					? { startedAt: now, completedAt: null }
					: {}),
				...(["completed", "failed", "exited", "canceled"].includes(
					patch.status,
				)
					? { completedAt: now }
					: {}),
			}
		: {}),
});
