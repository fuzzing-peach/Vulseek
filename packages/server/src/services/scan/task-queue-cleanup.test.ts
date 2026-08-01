import assert from "node:assert/strict";
import test from "node:test";
import type { Queue } from "bullmq";
import { removeKnownQueueJobsForTask } from "./task-queue-cleanup";

const makeWaitingQueue = (name: string, removed: string[]) =>
	({
		name,
		getJob: async (jobId: string) => ({
			getState: async () => "waiting",
			remove: async () => {
				removed.push(jobId);
			},
		}),
	} as unknown as Queue<string>);

test("removes a queued Research task by its canonical stage queue id", async () => {
	const removed: string[] = [];
	const queue = makeWaitingQueue(
		"scan:job-1:vulnerability-discovery",
		removed,
	);

	await removeKnownQueueJobsForTask(queue, {
		scanJobId: "job-1",
		stageName: "vulnerability-discovery",
		taskId: "task-1",
	});

	assert.deepEqual(removed, [
		"scan:job-1:vulnerability-discovery:task-1",
	]);
});

test("uses the group queue when removing a grouped Research task", async () => {
	const removed: string[] = [];
	const queue = makeWaitingQueue(
		"scan:job-1:group:group-1:track-review",
		removed,
	);

	await removeKnownQueueJobsForTask(queue, {
		scanJobId: "job-1",
		stageName: "track-review",
		taskId: "task-2",
	});

	assert.deepEqual(removed, ["scan:job-1:group:group-1:track-review:task-2"]);
});
