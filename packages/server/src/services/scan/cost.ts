import { calcPrice } from "@pydantic/genai-prices";
import type { TaskAgentProfileSnapshot } from "@dokploy/server/db/schema";

export const computeTaskCost = (
	inputTokens: number | null | undefined,
	outputTokens: number | null | undefined,
	cachedReadTokens: number | null | undefined,
	snapshot: TaskAgentProfileSnapshot | null | undefined,
): number | null => {
	const model = snapshot?.model;
	const pricingProvider = snapshot?.pricingProvider;
	if (!model || !pricingProvider) return null;
	// The library treats cache_read_tokens as a subset of input_tokens and re-prices
	// that portion at the cheaper cache rate. Our DB stores them separately, so we
	// pass (input + cache_read) as total input so the library's subtraction yields
	// the correct non-cached input cost.
	const cacheRead = cachedReadTokens ?? 0;
	const price = calcPrice(
		{
			input_tokens: (inputTokens ?? 0) + cacheRead,
			output_tokens: outputTokens ?? 0,
			cache_read_tokens: cacheRead,
		},
		model,
		{ providerId: pricingProvider },
	);
	return price?.total_price ?? null;
};
