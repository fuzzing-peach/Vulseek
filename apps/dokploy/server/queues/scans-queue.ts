import {
	findScanJobById,
	getScanJobConcurrencySetting,
	reconcileScanJobCandidatePipelineStatus,
	runScanJobInContainer,
	updateScanJobStatus,
} from "@dokploy/server";
import { type Job, Worker } from "bullmq";
import type { ScanQueueJob } from "./queue-types";
import { redisConfig } from "./redis-connection";

const MAX_SCAN_JOB_WORKER_CONCURRENCY = 16;

type ScanExecutionState = {
	active: number;
	waiters: Array<() => void>;
};

const scanExecutionState: ScanExecutionState = {
	active: 0,
	waiters: [],
};

const acquireScanExecutionSlot = async (limit: number) =>
	await new Promise<() => void>((resolve) => {
		const normalizedLimit = Math.max(1, limit);

		const tryAcquire = () => {
			if (scanExecutionState.active < normalizedLimit) {
				scanExecutionState.active += 1;
				resolve(() => {
					scanExecutionState.active = Math.max(0, scanExecutionState.active - 1);
					const next = scanExecutionState.waiters.shift();
					if (next) {
						queueMicrotask(next);
					}
				});
				return;
			}

			scanExecutionState.waiters.push(tryAcquire);
		};

		tryAcquire();
	});

export const scansWorker = new Worker(
	"scans",
	async (job: Job<ScanQueueJob>) => {
		const configuredConcurrency = await getScanJobConcurrencySetting();
		const releaseScanExecutionSlot =
			await acquireScanExecutionSlot(configuredConcurrency);

		try {
			const scanJob = await findScanJobById(job.data.scanJobId);
			const mode = job.data.mode || "full";

			if (mode === "full") {
				await updateScanJobStatus(scanJob.scanJobId, "scanning");
				await runScanJobInContainer(scanJob.scanJobId);
			}

			await reconcileScanJobCandidatePipelineStatus(scanJob.scanJobId);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			try {
				await updateScanJobStatus(job.data.scanJobId, "failed", message);
			} catch (_) {}
			console.log("Scan worker error", error);
		} finally {
			releaseScanExecutionSlot();
		}
	},
	{
		autorun: false,
		connection: redisConfig,
		concurrency: MAX_SCAN_JOB_WORKER_CONCURRENCY,
	},
);
