export const recoverFullScanQueuesPipeline = async <
	Job extends {
		scanJobId: string;
		scanType: string;
		repositoryTaskStatus: string;
	},
	ScanJob extends { scanJobId: string },
	ScanModuleTask extends {
		scanModuleTaskId: string;
		status: string;
	},
	ScanFunctionTask extends {
		scanFunctionTaskId: string;
		status: string;
	},
>(input: {
	loadJobs: () => Promise<Job[]>;
	loadScanJob: (scanJobId: string) => Promise<ScanJob>;
	loadModuleTasks: (scanJobId: string) => Promise<ScanModuleTask[]>;
	loadFunctionTasksByModuleTaskId: (
		scanModuleTaskId: string,
	) => Promise<ScanFunctionTask[]>;
	enqueueModuleScanWork: (
		scanJobId: string,
		scanModuleTaskId: string,
	) => Promise<unknown>;
	enqueueFunctionScanWork: (
		scanJobId: string,
		scanFunctionTaskId: string,
	) => Promise<unknown>;
	recalculateScanTaskCounts: (scanJobId: string) => Promise<unknown>;
	reconcilePipelineStatus: (scanJobId: string) => Promise<unknown>;
}) => {
	const jobs = await input.loadJobs();

	let moduleTasksEnqueued = 0;
	let functionTasksEnqueued = 0;

	for (const job of jobs) {
		if (job.scanType !== "full") {
			continue;
		}

		if (job.repositoryTaskStatus === "completed") {
			const moduleTasks = await input.loadModuleTasks(job.scanJobId);
			for (const moduleTask of moduleTasks) {
				if (moduleTask.status !== "completed" && moduleTask.status !== "failed") {
					await input.enqueueModuleScanWork(
						job.scanJobId,
						moduleTask.scanModuleTaskId,
					);
					moduleTasksEnqueued += 1;
					continue;
				}

				if (moduleTask.status === "completed") {
					const functionTasks = await input.loadFunctionTasksByModuleTaskId(
						moduleTask.scanModuleTaskId,
					);
					for (const functionTask of functionTasks) {
						if (
							functionTask.status === "completed" ||
							functionTask.status === "failed"
						) {
							continue;
						}
						await input.enqueueFunctionScanWork(
							job.scanJobId,
							functionTask.scanFunctionTaskId,
						);
						functionTasksEnqueued += 1;
					}
				}
			}
		}

		await input.recalculateScanTaskCounts(job.scanJobId).catch(() => {});
		await input.reconcilePipelineStatus(job.scanJobId).catch(() => {});
	}

	return {
		scanJobs: jobs.length,
		moduleTasksEnqueued,
		functionTasksEnqueued,
	};
};
