import { calcPrice } from "@pydantic/genai-prices";
import type { TaskAgentProfileSnapshot } from "@dokploy/server/db/schema";

export const computeTaskCost = (
	inputTokens: number | null | undefined,
	outputTokens: number | null | undefined,
	snapshot: TaskAgentProfileSnapshot | null | undefined,
): number | null => {
	const model = snapshot?.model;
	const pricingProvider = snapshot?.pricingProvider;
	if (!model || !pricingProvider) return null;
	const price = calcPrice(
		{ input_tokens: inputTokens ?? 0, output_tokens: outputTokens ?? 0 },
		model,
		{ providerId: pricingProvider },
	);
	return price?.total_price ?? null;
};
