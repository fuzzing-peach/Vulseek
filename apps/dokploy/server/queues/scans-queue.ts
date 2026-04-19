import {
	findScanJobById,
	runScanJobAnalysisPipeline,
	runScanJobInContainer,
	runScanJobVerificationPipeline,
	updateScanJobStatus,
} from "@dokploy/server";
import { type Job, Worker } from "bullmq";
import type { ScanQueueJob } from "./queue-types";
import { redisConfig } from "./redis-connection";

export const scansWorker = new Worker(
	"scans",
	async (job: Job<ScanQueueJob>) => {
		try {
			const scanJob = await findScanJobById(job.data.scanJobId);
			await updateScanJobStatus(scanJob.scanJobId, "scanning");

			await runScanJobInContainer(scanJob.scanJobId);

			const analysisResult = await runScanJobAnalysisPipeline(scanJob.scanJobId);
			if (analysisResult.failed > 0) {
				await updateScanJobStatus(
					scanJob.scanJobId,
					"failed",
					`${analysisResult.failed} candidate analyses failed`,
				);
				return;
			}

			const verificationResult = await runScanJobVerificationPipeline(
				scanJob.scanJobId,
			);
			if (verificationResult.failed > 0) {
				await updateScanJobStatus(
					scanJob.scanJobId,
					"failed",
					`${verificationResult.failed} candidate verifications failed`,
				);
				return;
			}

			await updateScanJobStatus(scanJob.scanJobId, "completed");
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			try {
				await updateScanJobStatus(job.data.scanJobId, "failed", message);
			} catch (_) {}
			console.log("Scan worker error", error);
		}
	},
	{
		autorun: false,
		connection: redisConfig,
	},
);
