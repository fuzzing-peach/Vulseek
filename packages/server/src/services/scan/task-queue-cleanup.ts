import type { Queue } from "bullmq";
import { buildKnownQueueJobIdsForTask } from "./queue-job-ids";
import type { Task } from "./types";

/**
 * Remove a task job from every BullMQ state that can retain it after a cancel.
 * The direct Redis cleanup is only a fallback for jobs whose metadata has
 * already disappeared, while normal jobs use BullMQ's remove operation.
 */
export const forceRemoveStageQueueJob = async (
	queue: Queue<string>,
	jobId: string,
) => {
	const existingJob = await queue.getJob(jobId).catch(() => null);
	if (existingJob) {
		const state = await existingJob.getState().catch(() => null);
		if (state && state !== "active") {
			await existingJob.remove().catch(() => {});
			return;
		}
	}

	const client = await queue.client;
	const jobKey = queue.toKey(jobId);
	await client
		.multi()
		.lrem(queue.toKey("active"), 0, jobId)
		.lrem(queue.toKey("wait"), 0, jobId)
		.lrem(queue.toKey("paused"), 0, jobId)
		.zrem(queue.toKey("delayed"), jobId)
		.zrem(queue.toKey("prioritized"), jobId)
		.zrem(queue.toKey("completed"), jobId)
		.zrem(queue.toKey("failed"), jobId)
		.zrem(queue.toKey("waiting-children"), jobId)
		.del(
			jobKey,
			`${jobKey}:lock`,
			`${jobKey}:logs`,
			`${jobKey}:dependencies`,
			`${jobKey}:processed`,
		)
		.exec();
};

export const removeKnownQueueJobsForTask = async (
	queue: Queue<string>,
	task: Pick<Task, "stageName" | "taskId" | "scanJobId">,
) => {
	await Promise.all(
		buildKnownQueueJobIdsForTask(queue, task).map((jobId) =>
			forceRemoveStageQueueJob(queue, jobId),
		),
	);
};
