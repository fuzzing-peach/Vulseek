import {
	findScanJobById,
	findScanJobPipeline,
	findScanJobQueueCounts,
	findScanJobRunningTasks,
} from "@vulseek/server";
import { createJobRuntimeStatusStore } from "./job-runtime-status";

export const jobRuntimeStatusStore = createJobRuntimeStatusStore({
	createLoaders: (scanJobId) => ({
		loadOverview: () => findScanJobById(scanJobId),
		loadRunningTasks: async () => ({
			tasks: await findScanJobRunningTasks(scanJobId),
		}),
		loadQueueCounts: async () => ({
			queues: await findScanJobQueueCounts(scanJobId),
		}),
		loadPipeline: () => findScanJobPipeline(scanJobId),
	}),
});
