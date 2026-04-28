export type ModuleStageTransitions<ScanModuleTask = unknown> = {
	start: (scanJobId: string, scanModuleTaskId: string) => Promise<unknown>;
	complete: (scanModuleTaskId: string) => Promise<unknown>;
	fail: (scanModuleTaskId: string, error: unknown) => Promise<unknown>;
	updateTask: (
		scanModuleTaskId: string,
		patch: Record<string, unknown>,
	) => Promise<ScanModuleTask>;
};

export const createModuleStageTransitions = <ScanModuleTask>(deps: {
	enterModuleScanning: (scanJobId: string) => Promise<unknown>;
	markTaskRunning: (scanModuleTaskId: string) => Promise<unknown>;
	markTaskCompleted: (scanModuleTaskId: string) => Promise<unknown>;
	markTaskFailed: (
		scanModuleTaskId: string,
		errorMessage?: string,
	) => Promise<unknown>;
	updateTask: ModuleStageTransitions<ScanModuleTask>["updateTask"];
}): ModuleStageTransitions<ScanModuleTask> => ({
	start: async (scanJobId, scanModuleTaskId) => {
		await deps.markTaskRunning(scanModuleTaskId);
		await deps.enterModuleScanning(scanJobId);
	},
	complete: async (scanModuleTaskId) =>
		await deps.markTaskCompleted(scanModuleTaskId),
	fail: async (scanModuleTaskId, error) =>
		await deps.markTaskFailed(
			scanModuleTaskId,
			error instanceof Error ? error.message : "Unknown error",
		),
	updateTask: deps.updateTask,
});
