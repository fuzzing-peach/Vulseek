export const getPendingScanTaskStateView = <
	ScanJob extends {
		repositoryTaskStatus: string;
	},
	ScanModuleTask extends {
		status: string;
	},
	ScanFunctionTask extends {
		status: string;
	},
>(input: {
	scanJob: ScanJob;
	moduleTasks: ScanModuleTask[];
	functionTasks: ScanFunctionTask[];
}) => {
	const repositoryPending =
		input.scanJob.repositoryTaskStatus !== "completed" &&
		input.scanJob.repositoryTaskStatus !== "failed";
	const modulePending = input.moduleTasks.filter(
		(moduleTask) =>
			moduleTask.status !== "completed" && moduleTask.status !== "failed",
	);
	const functionPending = input.functionTasks.filter(
		(functionTask) =>
			functionTask.status !== "completed" && functionTask.status !== "failed",
	);

	return {
		scanJob: input.scanJob,
		repositoryPending,
		modulePending,
		functionPending,
		moduleFailed: input.moduleTasks.filter((task) => task.status === "failed")
			.length,
		functionFailed: input.functionTasks.filter((task) => task.status === "failed")
			.length,
	};
};
