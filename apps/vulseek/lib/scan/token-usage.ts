export const cachedInputPercent = (
	inputTokens: number,
	cachedReadTokens: number,
) => {
	const allInputTokens = inputTokens + cachedReadTokens;
	return allInputTokens > 0 ? (cachedReadTokens / allInputTokens) * 100 : null;
};
