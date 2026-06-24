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
		case "delta-scope":
			return dedupe([currentJobId, `delta-scope:${input.scanJobId}`]);
		case "repository-scan":
		case "repository-profile":
			return dedupe([currentJobId, `repository:${input.scanJobId}`]);
		case "module-scan":
		case "identify-target":
			return dedupe([currentJobId, `module:${input.taskId}`]);
		case "module-threat-model":
		case "attack-surface-model":
			return dedupe([currentJobId, `module-threat-model:${input.taskId}`]);
		case "design-rule":
			return dedupe([currentJobId, `design-rule:${input.taskId}`]);
		case "scan-rule":
			return dedupe([currentJobId, `scan-rule:${input.taskId}`]);
		case "scan-pattern":
			return dedupe([currentJobId, `scan-pattern:${input.taskId}`]);
		case "sink-pre-analyze":
			return dedupe([currentJobId, `sink-pre-analyze:${input.taskId}`]);
		case "function-scan":
		case "scan-target":
			return dedupe([currentJobId, `function:${input.taskId}`]);
		case "analyze":
		case "analyze-finding":
			return dedupe([currentJobId, `analysis:${input.taskId}`]);
		case "verify":
		case "verify-finding":
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
