import { runScanEvaluation } from "@dokploy/server";
import { type Job, Worker } from "bullmq";
import type { ScanEvaluationQueueJob } from "./queue-types";
import { redisConfig } from "./redis-connection";

export const scanEvaluationsWorker = new Worker(
	"scan-evaluations",
	async (job: Job<ScanEvaluationQueueJob>) => {
		console.log(
			"[scan-evaluations-worker]",
			JSON.stringify({
				event: "scan-evaluation.start",
				evaluateResultId: job.data.evaluateResultId,
			}),
		);
		await runScanEvaluation(job.data.evaluateResultId);
		console.log(
			"[scan-evaluations-worker]",
			JSON.stringify({
				event: "scan-evaluation.completed",
				evaluateResultId: job.data.evaluateResultId,
			}),
		);
	},
	{
		autorun: false,
		connection: redisConfig,
		concurrency: 2,
	},
);
