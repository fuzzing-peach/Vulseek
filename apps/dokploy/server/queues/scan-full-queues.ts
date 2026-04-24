import {
	MAX_SCAN_FUNCTION_WORKER_CONCURRENCY,
	MAX_SCAN_MODULE_WORKER_CONCURRENCY,
	processScanFunctionQueueJob,
	processScanModuleQueueJob,
	recoverPendingFullScanQueues,
	SCAN_FUNCTION_QUEUE_NAME,
	SCAN_MODULE_QUEUE_NAME,
	type ScanFunctionQueueJob,
	type ScanModuleQueueJob,
} from "@dokploy/server";
import { type Job, Worker } from "bullmq";
import { redisConfig } from "./redis-connection";

export const scanModuleWorker = new Worker(
	SCAN_MODULE_QUEUE_NAME,
	async (job: Job<ScanModuleQueueJob>) => {
		await processScanModuleQueueJob(
			job.data.scanJobId,
			job.data.scanModuleTaskId,
		);
	},
	{
		autorun: false,
		connection: redisConfig,
		concurrency: MAX_SCAN_MODULE_WORKER_CONCURRENCY,
	},
);

export const scanFunctionWorker = new Worker(
	SCAN_FUNCTION_QUEUE_NAME,
	async (job: Job<ScanFunctionQueueJob>) => {
		await processScanFunctionQueueJob(
			job.data.scanJobId,
			job.data.scanFunctionTaskId,
		);
	},
	{
		autorun: false,
		connection: redisConfig,
		concurrency: MAX_SCAN_FUNCTION_WORKER_CONCURRENCY,
	},
);

export const recoverScanFullQueuesOnStartup = async () =>
	await recoverPendingFullScanQueues();
