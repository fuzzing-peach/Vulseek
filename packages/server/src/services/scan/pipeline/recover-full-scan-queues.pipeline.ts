export const recoverFullScanQueuesPipeline = async <
	Job extends {
		scanJobId: string;
		scanType: string;
		repositoryTaskStatus: string;
		status: string;
	},
	ScanJob extends { scanJobId: string },
	ModuleTask extends {
		taskId: string;
		status: string;
	},
	FunctionTask extends {
		taskId: string;
		status: string;
	},
	AnalysisTask extends {
		taskId: string;
		status: string;
	},
	VerificationTask extends {
		taskId: string;
		status: string;
	},
>(input: {
	loadJobs: () => Promise<Job[]>;
	loadScanJob: (scanJobId: string) => Promise<ScanJob>;
	enqueueRepositoryScanWork: (scanJobId: string) => Promise<unknown>;
	loadModuleTasks: (scanJobId: string) => Promise<ModuleTask[]>;
	loadFunctionTasksByModuleTaskId: (
		moduleTaskId: string,
	) => Promise<FunctionTask[]>;
	enqueueModuleScanWork: (
		scanJobId: string,
		moduleTaskId: string,
	) => Promise<unknown>;
	enqueueFunctionScanWork: (
		scanJobId: string,
		functionTaskId: string,
	) => Promise<unknown>;
	loadAnalysisTasks: (scanJobId: string) => Promise<AnalysisTask[]>;
	loadVerificationTasks: (scanJobId: string) => Promise<VerificationTask[]>;
	enqueueAnalysisWork: (
		scanJobId: string,
		analysisTaskId: string,
	) => Promise<unknown>;
	enqueueVerificationWork: (
		scanJobId: string,
		verificationTaskId: string,
	) => Promise<unknown>;
	updateScanJobStatus: (
		scanJobId: string,
		status: "running",
	) => Promise<unknown>;
	recalculateScanTaskCounts: (scanJobId: string) => Promise<unknown>;
	reconcilePipelineStatus: (scanJobId: string) => Promise<unknown>;
}) => {
	const jobs = await input.loadJobs();

	let repositoryTasksEnqueued = 0;
	let moduleTasksEnqueued = 0;
	let functionTasksEnqueued = 0;
	let analysisTasksEnqueued = 0;
	let verificationTasksEnqueued = 0;

	for (const job of jobs) {
		if (job.scanType !== "full") {
			continue;
		}

		if (job.repositoryTaskStatus === "pending") {
			await input.enqueueRepositoryScanWork(job.scanJobId);
			repositoryTasksEnqueued += 1;
		}

		if (job.repositoryTaskStatus === "completed") {
			const moduleTasks = await input.loadModuleTasks(job.scanJobId);
			for (const moduleTask of moduleTasks) {
				if (moduleTask.status === "pending") {
					await input.enqueueModuleScanWork(
						job.scanJobId,
						moduleTask.taskId,
					);
					moduleTasksEnqueued += 1;
					continue;
				}

					if (moduleTask.status === "completed") {
						const functionTasks = await input.loadFunctionTasksByModuleTaskId(
							moduleTask.taskId,
						);
						for (const functionTask of functionTasks) {
							if (functionTask.status !== "pending") {
								continue;
							}
							await input.enqueueFunctionScanWork(
								job.scanJobId,
								functionTask.taskId,
						);
						functionTasksEnqueued += 1;
					}
				}
			}
		}

			const analysisTasks = await input.loadAnalysisTasks(job.scanJobId);
			for (const analysisTask of analysisTasks) {
				if (analysisTask.status !== "pending") {
					continue;
				}
				await input.enqueueAnalysisWork(job.scanJobId, analysisTask.taskId);
				analysisTasksEnqueued += 1;
			}

			const verificationTasks = await input.loadVerificationTasks(job.scanJobId);
			for (const verificationTask of verificationTasks) {
				if (verificationTask.status !== "pending") {
					continue;
				}
				await input.enqueueVerificationWork(
					job.scanJobId,
					verificationTask.taskId,
			);
			verificationTasksEnqueued += 1;
		}

			if (
				job.status !== "running" &&
				job.status !== "pending" &&
				(verificationTasks.some((task) => task.status === "pending") ||
					analysisTasks.some((task) => task.status === "pending"))
			) {
				await input.updateScanJobStatus(job.scanJobId, "running").catch(
					() => {},
				);
			}

		await input.recalculateScanTaskCounts(job.scanJobId).catch(() => {});
		await input.reconcilePipelineStatus(job.scanJobId).catch(() => {});
	}

	return {
		scanJobs: jobs.length,
		repositoryTasksEnqueued,
		moduleTasksEnqueued,
		functionTasksEnqueued,
		analysisTasksEnqueued,
		verificationTasksEnqueued,
	};
};
