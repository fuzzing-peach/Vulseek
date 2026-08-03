import { calcPrice } from "@pydantic/genai-prices";
import type { TaskAgentProfileSnapshot } from "@vulseek/server/db/schema";

export type TaskCostSource = {
	inputTokens: number | null | undefined;
	outputTokens: number | null | undefined;
	cachedReadTokens: number | null | undefined;
	cachedWriteTokens: number | null | undefined;
	agentProfile: TaskAgentProfileSnapshot | null | undefined;
};

export type TaskCostPatch = Partial<TaskCostSource>;

const toBillableTokenCount = (value: number | null | undefined) =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

export const computeTaskCost = (source: TaskCostSource): number | null => {
	const model = source.agentProfile?.model;
	const pricingProvider = source.agentProfile?.pricingProvider;
	if (!model || !pricingProvider) return null;

	const input = toBillableTokenCount(source.inputTokens);
	const output = toBillableTokenCount(source.outputTokens);
	const cacheRead = toBillableTokenCount(source.cachedReadTokens);
	const cacheWrite = toBillableTokenCount(source.cachedWriteTokens);
	const price = calcPrice(
		{
			// The pricing library expects cache tokens to be subsets of input_tokens.
			// Agent usage stores each category separately, so rebuild the total here.
			input_tokens: input + cacheRead + cacheWrite,
			output_tokens: output,
			cache_read_tokens: cacheRead,
			cache_write_tokens: cacheWrite,
		},
		model,
		{ providerId: pricingProvider },
	);
	return price?.total_price ?? null;
};

export const computePatchedTaskCost = (
	current: TaskCostSource,
	patch: TaskCostPatch,
): number | null =>
	computeTaskCost({
		inputTokens:
			"inputTokens" in patch ? patch.inputTokens : current.inputTokens,
		outputTokens:
			"outputTokens" in patch ? patch.outputTokens : current.outputTokens,
		cachedReadTokens:
			"cachedReadTokens" in patch
				? patch.cachedReadTokens
				: current.cachedReadTokens,
		cachedWriteTokens:
			"cachedWriteTokens" in patch
				? patch.cachedWriteTokens
				: current.cachedWriteTokens,
		agentProfile:
			"agentProfile" in patch ? patch.agentProfile : current.agentProfile,
	});
