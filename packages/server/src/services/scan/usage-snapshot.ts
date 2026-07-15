import { promises as fs } from "node:fs";

export type AgentTokenUsage = {
	totalTokens: number;
	cachedReadTokens: number;
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
	return {
		totalTokens: explicitTotal ?? inputTokens + outputTokens,
		cachedReadTokens:
			numberAt(usage, [
				"cachedReadTokens",
				"cached_read_tokens",
				"cacheReadInputTokens",
				"cache_read_input_tokens",
			]) ?? 0,
	};
};

export const readAgentUsageSnapshot = async (
	filePath: string,
): Promise<AgentTokenUsage> => {
	try {
		return parseAgentUsageSnapshot(
			JSON.parse(await fs.readFile(filePath, "utf-8")),
		);
	} catch {
		return { totalTokens: 0, cachedReadTokens: 0 };
	}
};
