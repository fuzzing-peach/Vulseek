import type { Queue } from "bullmq";
import type { Task } from "./types";

const dedupe = (values: string[]) => [...new Set(values.filter(Boolean))];

export const buildQueueTaskJobId = (queueName: string, taskId: string) =>
	`${queueName}:${taskId}`;

export const buildKnownStageQueueJobIds = (input: {
	queueName: string;
	stageName: Task["stageName"];
	taskId: string;
	scanJobId: string;
}) => {
	const currentJobId = buildQueueTaskJobId(input.queueName, input.taskId);

	switch (input.stageName) {
		case "repository-scan":
			return dedupe([currentJobId, `repository:${input.scanJobId}`]);
		case "module-scan":
			return dedupe([currentJobId, `module:${input.taskId}`]);
		case "function-scan":
			return dedupe([currentJobId, `function:${input.taskId}`]);
		case "analyze":
			return dedupe([currentJobId, `analysis:${input.taskId}`]);
		case "verify":
			return dedupe([currentJobId, `verification:${input.taskId}`]);
		default:
			return [currentJobId];
	}
};

export const buildKnownQueueJobIdsForTask = (
	queue: Pick<Queue<string>, "name">,
	task: Pick<Task, "stageName" | "taskId" | "scanJobId">,
) =>
	buildKnownStageQueueJobIds({
		queueName: queue.name,
		stageName: task.stageName,
		taskId: task.taskId,
		scanJobId: task.scanJobId,
	});
