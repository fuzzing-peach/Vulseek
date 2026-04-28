export type CandidateStageTransitions = {
	startAnalysis: (vulnerabilityCandidateId: string) => Promise<unknown>;
	completeAnalysis: (vulnerabilityCandidateId: string) => Promise<unknown>;
	failAnalysis: (vulnerabilityCandidateId: string) => Promise<unknown>;
	queueVerification: (
		vulnerabilityCandidateId: string,
	) => Promise<unknown>;
	startVerification: (vulnerabilityCandidateId: string) => Promise<unknown>;
	completeVerification: (
		vulnerabilityCandidateId: string,
	) => Promise<unknown>;
	failVerification: (
		vulnerabilityCandidateId: string,
	) => Promise<unknown>;
};

export const createCandidateStageTransitions = (deps: {
	updateStatus: (
		vulnerabilityCandidateId: string,
		status: "queued" | "running" | "completed" | "failed",
	) => Promise<unknown>;
	updateStage: (
		vulnerabilityCandidateId: string,
		stage: "analyzing" | "verifying",
	) => Promise<unknown>;
}): CandidateStageTransitions => ({
	startAnalysis: async (vulnerabilityCandidateId) => {
		await deps.updateStatus(vulnerabilityCandidateId, "running");
		await deps.updateStage(vulnerabilityCandidateId, "analyzing");
	},
	completeAnalysis: async (vulnerabilityCandidateId) =>
		await deps.updateStatus(vulnerabilityCandidateId, "completed"),
	failAnalysis: async (vulnerabilityCandidateId) =>
		await deps.updateStatus(vulnerabilityCandidateId, "failed"),
	queueVerification: async (vulnerabilityCandidateId) => {
		await deps.updateStatus(vulnerabilityCandidateId, "queued");
		await deps.updateStage(vulnerabilityCandidateId, "verifying");
	},
	startVerification: async (vulnerabilityCandidateId) => {
		await deps.updateStatus(vulnerabilityCandidateId, "running");
		await deps.updateStage(vulnerabilityCandidateId, "verifying");
	},
	completeVerification: async (vulnerabilityCandidateId) =>
		await deps.updateStatus(vulnerabilityCandidateId, "completed"),
	failVerification: async (vulnerabilityCandidateId) =>
		await deps.updateStatus(vulnerabilityCandidateId, "failed"),
});
