export type AgentTokenUsage = {
	inputTokens: number;
	outputTokens: number;
	thoughtTokens: number;
	totalTokens: number;
	cachedReadTokens: number;
	cachedWriteTokens: number;
};

const asRecord = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

const numberAt = (record: Record<string, unknown>, keys: string[]) => {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
			return value;
		}
	}
	return null;
};

export const parseAgentUsageSnapshot = (value: unknown): AgentTokenUsage => {
	const usage = asRecord(value);
	const explicitTotal = numberAt(usage, [
		"totalTokens",
		"total_tokens",
		"used",
	]);
	const inputTokens = numberAt(usage, ["inputTokens", "input_tokens"]) ?? 0;
	const outputTokens = numberAt(usage, ["outputTokens", "output_tokens"]) ?? 0;
	const thoughtTokens =
		numberAt(usage, ["thoughtTokens", "thought_tokens", "reasoningTokens"]) ??
		0;
	return {
		inputTokens,
		outputTokens,
		thoughtTokens,
		totalTokens: explicitTotal ?? inputTokens + outputTokens,
		cachedReadTokens:
			numberAt(usage, [
				"cachedReadTokens",
				"cached_read_tokens",
				"cacheReadInputTokens",
				"cache_read_input_tokens",
			]) ?? 0,
		cachedWriteTokens:
			numberAt(usage, [
				"cachedWriteTokens",
				"cached_write_tokens",
				"cacheCreationInputTokens",
				"cache_creation_input_tokens",
			]) ?? 0,
	};
};
