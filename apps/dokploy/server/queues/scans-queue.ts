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
const SCAN_JOB_CANCELLED_ERROR_NAME = "ScanJobCancelledError";

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
			if (scanJob.status === "canceled") {
				return;
			}

			const mode = job.data.mode || "full";
			console.log(
				"[scans-worker]",
				JSON.stringify({
					event: "scan-job.start",
					scanJobId: scanJob.scanJobId,
					mode,
				}),
			);

			if (mode === "full") {
				const latestScanJob = await findScanJobById(job.data.scanJobId);
				if (latestScanJob.status === "canceled") {
					return;
				}
				if (latestScanJob.status === "running") {
					console.log(
						"[scans-worker]",
						JSON.stringify({
							event: "scan-job.resume_already_running",
							scanJobId: latestScanJob.scanJobId,
							mode,
						}),
					);
					await runScanJobInContainer(scanJob.scanJobId, {
						enqueueInitialRepositoryTask: false,
					});
					await reconcileScanJobCandidatePipelineStatus(scanJob.scanJobId);
					return;
				}
			}
			await updateScanJobStatus(scanJob.scanJobId, "running");
			await runScanJobInContainer(scanJob.scanJobId, {
				enqueueInitialRepositoryTask: mode === "full",
			});

			await reconcileScanJobCandidatePipelineStatus(scanJob.scanJobId);
			console.log(
				"[scans-worker]",
				JSON.stringify({
					event: "scan-job.completed",
					scanJobId: scanJob.scanJobId,
					mode,
				}),
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.name === SCAN_JOB_CANCELLED_ERROR_NAME
			) {
				return;
			}

			try {
				const latestScanJob = await findScanJobById(job.data.scanJobId);
				if (latestScanJob.status === "canceled") {
					return;
				}
			} catch (_) {}

			const message = error instanceof Error ? error.message : "Unknown error";
			try {
				await updateScanJobStatus(job.data.scanJobId, "finished", message);
			} catch (_) {}
			console.log(
				"[scans-worker]",
				JSON.stringify({
					event: "scan-job.failed",
					scanJobId: job.data.scanJobId,
					errorMessage: message,
				}),
			);
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
