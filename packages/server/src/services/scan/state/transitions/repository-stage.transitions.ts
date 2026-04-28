export type RepositoryStageTransitions = {
	start: (scanJobId: string) => Promise<unknown>;
	complete: (scanJobId: string) => Promise<unknown>;
	updateThreadId: (scanJobId: string, threadId: string) => Promise<unknown>;
	updateTargetContext: (
		scanJobId: string,
		context: {
			targetRef: string | null;
			targetTag: string | null;
			commitSha: string;
			baseSha: string | null;
			commitWindow: number;
		},
	) => Promise<unknown>;
};

export const createRepositoryStageTransitions = (deps: {
	enterRepositoryScanning: (
		scanJobId: string,
	) => Promise<unknown>;
	markRepositoryRunning: (scanJobId: string) => Promise<unknown>;
	markRepositoryCompleted: (scanJobId: string) => Promise<unknown>;
	updateThreadId: (scanJobId: string, threadId: string) => Promise<unknown>;
	updateTargetContext: RepositoryStageTransitions["updateTargetContext"];
}): RepositoryStageTransitions => ({
	start: async (scanJobId) => {
		await deps.enterRepositoryScanning(scanJobId);
		await deps.markRepositoryRunning(scanJobId);
	},
	complete: async (scanJobId) =>
		await deps.markRepositoryCompleted(scanJobId),
	updateThreadId: deps.updateThreadId,
	updateTargetContext: deps.updateTargetContext,
});
