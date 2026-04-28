export type FunctionStageTransitions = {
	start: (scanJobId: string, scanFunctionTaskId: string) => Promise<unknown>;
	complete: (scanFunctionTaskId: string) => Promise<unknown>;
	fail: (scanFunctionTaskId: string, error: unknown) => Promise<unknown>;
	updateTask: (
		scanFunctionTaskId: string,
		patch: Record<string, unknown>,
	) => Promise<unknown>;
};

export const createFunctionStageTransitions = (deps: {
	enterFunctionScanning: (scanJobId: string) => Promise<unknown>;
	markTaskRunning: (scanFunctionTaskId: string) => Promise<unknown>;
	markTaskCompleted: (scanFunctionTaskId: string) => Promise<unknown>;
	markTaskFailed: (
		scanFunctionTaskId: string,
		errorMessage?: string,
	) => Promise<unknown>;
	updateTask: FunctionStageTransitions["updateTask"];
}): FunctionStageTransitions => ({
	start: async (scanJobId, scanFunctionTaskId) => {
		await deps.markTaskRunning(scanFunctionTaskId);
		await deps.enterFunctionScanning(scanJobId);
	},
	complete: async (scanFunctionTaskId) =>
		await deps.markTaskCompleted(scanFunctionTaskId),
	fail: async (scanFunctionTaskId, error) =>
		await deps.markTaskFailed(
			scanFunctionTaskId,
			error instanceof Error ? error.message : "Unknown error",
		),
	updateTask: deps.updateTask,
});
