import type { Task } from "../types";

const positiveTokenCount = (value: number | null | undefined) =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

const taskUsesClaudeUsageSemantics = (
	task: Pick<Task, "agentProfile">,
): boolean => task.agentProfile?.provider === "claude_code";

export const normalizeTaskApiTokenUsage = <T extends Task>(task: T): T => {
	if (!taskUsesClaudeUsageSemantics(task)) {
		return task;
	}
	if (task.inputTokens == null) {
		return task;
	}
	const cachedInputTokens = positiveTokenCount(task.cachedReadTokens);
	if (cachedInputTokens <= 0) {
		return task;
	}
	return {
		...task,
		inputTokens: task.inputTokens + cachedInputTokens,
	};
};

export const normalizeTasksApiTokenUsage = <T extends Task>(tasks: T[]): T[] =>
	tasks.map(normalizeTaskApiTokenUsage);
