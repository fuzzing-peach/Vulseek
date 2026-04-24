import {
	MAX_CANDIDATE_ANALYSIS_WORKER_CONCURRENCY,
	processCandidateAnalysisQueueJob,
	processCandidateVerificationQueueJob,
	recoverPendingScanCandidateQueues,
	MAX_CANDIDATE_VERIFICATION_WORKER_CONCURRENCY,
	SCAN_CANDIDATE_ANALYSIS_QUEUE_NAME,
	SCAN_CANDIDATE_VERIFICATION_QUEUE_NAME,
	type ScanCandidateQueueJob,
} from "@dokploy/server";
import { type Job, Worker } from "bullmq";
import { redisConfig } from "./redis-connection";

export const scanCandidateAnalysisWorker = new Worker(
	SCAN_CANDIDATE_ANALYSIS_QUEUE_NAME,
	async (job: Job<ScanCandidateQueueJob>) => {
		await processCandidateAnalysisQueueJob(
			job.data.scanJobId,
			job.data.vulnerabilityCandidateId,
		);
	},
	{
		autorun: false,
		connection: redisConfig,
		concurrency: MAX_CANDIDATE_ANALYSIS_WORKER_CONCURRENCY,
	},
);

export const scanCandidateVerificationWorker = new Worker(
	SCAN_CANDIDATE_VERIFICATION_QUEUE_NAME,
	async (job: Job<ScanCandidateQueueJob>) => {
		await processCandidateVerificationQueueJob(
			job.data.scanJobId,
			job.data.vulnerabilityCandidateId,
		);
	},
	{
		autorun: false,
		connection: redisConfig,
		concurrency: MAX_CANDIDATE_VERIFICATION_WORKER_CONCURRENCY,
	},
);

export const recoverScanCandidateQueuesOnStartup = async () =>
	await recoverPendingScanCandidateQueues();
