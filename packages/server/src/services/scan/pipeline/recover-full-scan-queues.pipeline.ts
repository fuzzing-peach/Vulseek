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
	TriageTask extends {
		taskId: string;
		status: string;
	},
>(input: {
	loadJobs: () => Promise<Job[]>;
	loadScanJob: (scanJobId: string) => Promise<ScanJob>;
	enqueueRepositoryProfileWork: (scanJobId: string) => Promise<unknown>;
	loadModuleTasks: (scanJobId: string) => Promise<ModuleTask[]>;
	loadFunctionTasksByModuleTaskId: (
		moduleTaskId: string,
	) => Promise<FunctionTask[]>;
	enqueueIdentifyTargetWork: (
		scanJobId: string,
		moduleTaskId: string,
	) => Promise<unknown>;
	enqueueScanTargetWork: (
		scanJobId: string,
		functionTaskId: string,
	) => Promise<unknown>;
	loadAnalysisTasks: (scanJobId: string) => Promise<AnalysisTask[]>;
	loadVerificationTasks: (scanJobId: string) => Promise<VerificationTask[]>;
	loadTriageTasks: (scanJobId: string) => Promise<TriageTask[]>;
	enqueueAnalysisWork: (
		scanJobId: string,
		analysisTaskId: string,
	) => Promise<unknown>;
	enqueueVerificationWork: (
		scanJobId: string,
		verificationTaskId: string,
	) => Promise<unknown>;
	enqueueTriageWork: (
		scanJobId: string,
		triageTaskId: string,
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
	let triageTasksEnqueued = 0;

	for (const job of jobs) {
		if (job.scanType !== "full") {
			continue;
		}
		if (job.status === "canceled") {
			continue;
		}

		if (job.repositoryTaskStatus === "pending") {
			await input.enqueueRepositoryProfileWork(job.scanJobId);
			repositoryTasksEnqueued += 1;
		}

		if (job.repositoryTaskStatus === "completed") {
			const moduleTasks = await input.loadModuleTasks(job.scanJobId);
			for (const moduleTask of moduleTasks) {
				if (moduleTask.status === "pending") {
					await input.enqueueIdentifyTargetWork(
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
							await input.enqueueScanTargetWork(
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

			const triageTasks = await input.loadTriageTasks(job.scanJobId);
			for (const triageTask of triageTasks) {
				if (triageTask.status !== "pending") {
					continue;
				}
				await input.enqueueTriageWork(job.scanJobId, triageTask.taskId);
				triageTasksEnqueued += 1;
			}

			if (
				job.status !== "running" &&
				job.status !== "pending" &&
				(verificationTasks.some((task) => task.status === "pending") ||
					analysisTasks.some((task) => task.status === "pending") ||
					triageTasks.some((task) => task.status === "pending"))
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
		triageTasksEnqueued,
	};
};
